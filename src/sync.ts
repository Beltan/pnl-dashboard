import { walk, type TokenRow, type TxRow } from "./chain/explorer.ts";
import { log } from "./log.ts";
import { Store, type TradeRecord, type TransferRecord } from "./store.ts";
import type { AppConfig, ChainConfig } from "./types.ts";

export interface ChainState {
  /** Null until the first pass finishes. */
  syncedAt: number | null;
  backfilling: boolean;
  error: string | null;
  trades: number;
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

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
  ) {
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

  /** One pass over every chain. Passes never overlap: a backfill can outlast the interval. */
  async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const chain of this.config.chains) await this.syncChain(chain);
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
    try {
      for (const entry of chain.watched) {
        trades += await this.syncTrades(chain, entry.address, watched);
        transfers += await this.syncTransfers(chain, entry.address, watched);
      }
      held.error = null;
      held.backfilling = false;
      held.syncedAt = Date.now();
      held.trades = this.store.stats().trades;
      if (trades || transfers) {
        log.info("Chain synced", { chain: chain.name, trades, transfers, ms: Date.now() - started });
      }
    } catch (error) {
      held.error = String(error);
      log.error("A chain sync failed", { chain: chain.name, error: String(error) });
    }
  }

  private async syncTrades(chain: ChainConfig, address: string, watched: Set<string>): Promise<number> {
    const from = this.store.cursor(chain.name, address, "txlist");
    let written = 0;
    const highest = await walk<TxRow>(chain.explorerUrl, "txlist", address, from, (rows) => {
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
    if (highest > from) this.store.setCursor(chain.name, address, "txlist", highest);
    return written;
  }

  private async syncTransfers(chain: ChainConfig, address: string, watched: Set<string>): Promise<number> {
    const from = this.store.cursor(chain.name, address, "tokentx");
    let written = 0;
    const highest = await walk<TokenRow>(chain.explorerUrl, "tokentx", address, from, (rows) => {
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
    return written;
  }
}
