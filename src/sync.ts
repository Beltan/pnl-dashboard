import { walk, type TokenRow, type TxRow } from "./chain/explorer.ts";
import { short } from "./config.ts";
import { log } from "./log.ts";
import { Store, type TradeRecord, type TransferRecord } from "./store.ts";
import type { AppConfig, ChainConfig } from "./types.ts";

export interface ChainState {
  /** When a pass last read every watched address to the end of its history. Null until then. */
  syncedAt: number | null;
  backfilling: boolean;
  /** What stopped the last pass short, or null if it completed. */
  error: string | null;
  trades: number;
}

/** What one address's walk read, and what stopped it if anything did. */
interface Read {
  written: number;
  error: string | null;
}

/** Raw units as a double: the magnitude is exact and the precision is far past any USD figure. */
function raw(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class Sync {
  private readonly state = new Map<string, ChainState>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  // Assigned in the body rather than declared as constructor parameters: Node's type stripping,
  // which `npm run dev` and `npm test` both use, cannot erase a parameter property.
  private readonly config: AppConfig;
  private readonly store: Store;

  constructor(config: AppConfig, store: Store) {
    this.config = config;
    this.store = store;
    for (const chain of config.chains) {
      this.state.set(chain.name, { syncedAt: null, backfilling: true, error: null, trades: 0 });
    }
  }

  snapshot(): Map<string, ChainState> {
    return this.state;
  }

  start(): void {
    void this.pass();
    this.timer = setInterval(() => void this.pass(), this.config.refreshSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every chain. Passes never overlap: a backfill can outlast the interval.
   *
   * Chains run together, since each has its own explorer and a long backfill on one would
   * otherwise hold every other chain at zero until it finished. Addresses within a chain stay
   * sequential, which is what keeps one explorer from being hit in parallel.
   */
  async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all(this.config.chains.map((chain) => this.syncChain(chain)));
    } finally {
      this.running = false;
    }
  }

  private async syncChain(chain: ChainConfig): Promise<void> {
    const held = this.state.get(chain.name)!;
    const started = Date.now();
    const watched = new Set(chain.watched.map((entry) => entry.address));
    let trades = 0;
    let transfers = 0;
    // A page that fails leaves the rest of that address for the next pass. The pass is still
    // incomplete, so it is reported rather than passed off as a sync that found nothing.
    const failures: string[] = [];
    try {
      for (const entry of chain.watched) {
        const txlist = await this.syncTrades(chain, entry.address, watched);
        trades += txlist.written;
        if (txlist.error) failures.push(`${short(entry.address)} txlist: ${txlist.error}`);
        const tokentx = await this.syncTransfers(chain, entry.address, watched);
        transfers += tokentx.written;
        if (tokentx.error) failures.push(`${short(entry.address)} tokentx: ${tokentx.error}`);
      }
      held.trades = this.store.stats().trades;
      if (failures.length > 0) {
        held.error = failures.join("; ");
        log.error("A chain sync did not complete", { chain: chain.name, failures: failures.length, error: held.error });
      } else {
        held.error = null;
        held.backfilling = false;
        held.syncedAt = Date.now();
      }
      if (trades || transfers) {
        log.info("Chain synced", { chain: chain.name, trades, transfers, ms: Date.now() - started });
      }
    } catch (error) {
      held.error = String(error);
      log.error("A chain sync failed", { chain: chain.name, error: String(error) });
    }
  }

  private async syncTrades(chain: ChainConfig, address: string, watched: Set<string>): Promise<Read> {
    const from = this.store.cursor(chain.name, address, "txlist");
    let written = 0;
    const { highest, error } = await walk<TxRow>(chain.explorerUrl, "txlist", address, from, (rows) => {
      const records: TradeRecord[] = rows.map((row) => {
        const sender = row.from.toLowerCase();
        const gasUsed = Number(row.gasUsed);
        const gasPrice = raw(row.gasPrice);
        return {
          chain: chain.name,
          hash: row.hash.toLowerCase(),
          from: sender,
          to: row.to ? row.to.toLowerCase() : null,
          block: Number(row.blockNumber),
          ts: Number(row.timeStamp),
          // Blockscout leaves txreceipt_status empty on very old rows; isError carries the same verdict.
          status: row.txreceipt_status === "" ? (row.isError === "1" ? 0 : 1) : Number(row.txreceipt_status),
          gasUsed,
          gasNative: (gasUsed * gasPrice) / 10 ** chain.nativeDecimals,
          gasOurs: watched.has(sender),
        };
      });
      written += this.store.putTrades(records);
    });
    // The blocks that were read are kept even when the walk stopped short, so a failure costs the
    // next pass one page rather than the whole backfill.
    if (highest > from) this.store.setCursor(chain.name, address, "txlist", highest);
    return { written, error };
  }

  private async syncTransfers(chain: ChainConfig, address: string, watched: Set<string>): Promise<Read> {
    const from = this.store.cursor(chain.name, address, "tokentx");
    let written = 0;
    const { highest, error } = await walk<TokenRow>(chain.explorerUrl, "tokentx", address, from, (rows) => {
      const records: TransferRecord[] = [];
      for (const row of rows) {
        const to = row.to.toLowerCase();
        const sender = row.from.toLowerCase();
        const inbound = watched.has(to);
        const outbound = watched.has(sender);
        // A movement between two watched addresses nets to nothing and is not worth a row.
        if (inbound === outbound) continue;
        const decimals = Number(row.tokenDecimal);
        records.push({
          chain: chain.name,
          hash: row.hash.toLowerCase(),
          token: row.contractAddress.toLowerCase(),
          symbol: row.tokenSymbol || row.contractAddress.slice(0, 8),
          decimals: Number.isFinite(decimals) ? decimals : 18,
          from: sender,
          to,
          value: row.value,
          delta: inbound ? raw(row.value) : -raw(row.value),
        });
      }
      written += this.store.putTransfers(records);
    });
    if (highest > from) this.store.setCursor(chain.name, address, "tokentx", highest);
    return { written, error };
  }
}
