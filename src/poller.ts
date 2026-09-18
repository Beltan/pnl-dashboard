import { sentSince } from "./chain/explorer.ts";
import { keptBy, gasNative, toWhole } from "./chain/pnl.ts";
import { receipts } from "./chain/rpc.ts";
import { tokenMeta, type TokenMeta } from "./chain/tokens.ts";
import { log } from "./log.ts";
import { Prices } from "./pricing.ts";
import type { AppConfig, ChainConfig, Trade } from "./types.ts";

export interface ChainState {
  trades: Trade[];
  refreshedAt: number | null;
  error: string | null;
}

/** Holds the window in memory and refreshes it on a timer. The chain is the record; nothing is written. */
export class Poller {
  private readonly state = new Map<string, ChainState>();
  private readonly prices = new Prices();
  private readonly meta = new Map<string, TokenMeta>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: AppConfig) {
    for (const chain of config.chains) this.state.set(chain.name, { trades: [], refreshedAt: null, error: null });
  }

  snapshot(): Map<string, ChainState> {
    return this.state;
  }

  trades(): Trade[] {
    return [...this.state.values()].flatMap((chain) => chain.trades).sort((a, b) => b.timestamp - a.timestamp);
  }

  start(): void {
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), this.config.refreshSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.config.chains.map((chain) => this.refresh(chain)));
  }

  private async refresh(chain: ChainConfig): Promise<void> {
    const started = Date.now();
    const since = Math.floor(started / 1000) - this.config.windowHours * 3600;
    const held = this.state.get(chain.name)!;
    try {
      const watched = new Set(chain.watched.map((entry) => entry.address));
      const labels = new Map(chain.watched.map((entry) => [entry.address, entry.label]));

      const lists = await Promise.all(chain.watched.map((entry) => sentSince(chain.explorerUrl, entry.address, since)));
      const rows = lists.flat();
      const found = await receipts(chain.rpcUrl, rows.map((row) => row.hash));

      // One pass to learn which tokens appear, so metadata and prices are fetched once.
      const kept = new Map<string, { token: string; raw: bigint }>();
      for (const row of rows) {
        const receipt = found.get(row.hash.toLowerCase());
        if (!receipt) continue;
        const surplus = keptBy(receipt, watched);
        if (surplus) kept.set(row.hash.toLowerCase(), surplus);
      }
      const tokens = [...new Set([...kept.values()].map((entry) => entry.token))];
      const unknown = tokens.filter((token) => !this.meta.has(token));
      for (const [token, meta] of await tokenMeta(chain.rpcUrl, unknown)) this.meta.set(token, meta);

      const priced = [...tokens];
      if (chain.nativePriceToken) priced.push(chain.nativePriceToken);
      await this.prices.load(chain.geckoNetwork, priced);
      const nativeUsd = chain.nativePriceToken ? this.prices.usd(chain.geckoNetwork, chain.nativePriceToken) : null;

      const trades: Trade[] = [];
      for (const row of rows) {
        const receipt = found.get(row.hash.toLowerCase());
        if (!receipt) continue;
        const gasUsed = BigInt(receipt.gasUsed);
        const gasPrice = BigInt(receipt.effectiveGasPrice ?? "0x0");
        const native = gasNative(gasUsed, gasPrice, chain.nativeDecimals);
        const gasUsd = nativeUsd === null ? null : native * nativeUsd;

        const surplus = kept.get(row.hash.toLowerCase()) ?? null;
        const meta = surplus ? this.meta.get(surplus.token) : undefined;
        const tokenUsd = surplus ? this.prices.usd(chain.geckoNetwork, surplus.token) : null;
        const profitUsd =
          surplus && meta && tokenUsd !== null ? toWhole(surplus.raw, meta.decimals) * tokenUsd : null;

        trades.push({
          chain: chain.name,
          hash: row.hash,
          from: row.from.toLowerCase(),
          fromLabel: labels.get(row.from.toLowerCase()) ?? row.from,
          to: row.to ? row.to.toLowerCase() : null,
          blockNumber: Number(row.blockNumber),
          timestamp: Number(row.timeStamp),
          status: Number(BigInt(receipt.status)),
          gasUsed: Number(gasUsed),
          effectiveGasPrice: gasPrice.toString(),
          gasNative: native,
          gasUsd,
          profitToken: surplus?.token ?? null,
          profitSymbol: meta?.symbol ?? null,
          profitRaw: surplus ? surplus.raw.toString() : null,
          profitUsd,
          netUsd: profitUsd === null || gasUsd === null ? null : profitUsd - gasUsd,
        });
      }

      trades.sort((a, b) => b.timestamp - a.timestamp);
      held.trades = trades;
      held.refreshedAt = Date.now();
      held.error = null;
      log.info("Chain refreshed", { chain: chain.name, trades: trades.length, ms: Date.now() - started });
    } catch (error) {
      held.error = String(error);
      log.error("A chain refresh failed", { chain: chain.name, error: String(error) });
    }
  }
}
