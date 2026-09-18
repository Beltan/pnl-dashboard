import type { Prices } from "./pricing.ts";
import type { QueryRow, Store } from "./store.ts";
import type { ChainConfig, Totals, Trade } from "./types.ts";

export interface Query {
  chain?: string;
  address?: string;
  outcome?: "landed" | "reverted";
  hours?: number;
}

/** Parameterised throughout: the filters come off a query string. */
export function clauses(query: Query, now = Math.floor(Date.now() / 1000)): { where: string; params: unknown[] } {
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (query.chain) {
    where.push("t.chain = ?");
    params.push(query.chain);
  }
  if (query.address) {
    where.push("(t.from_addr = ? OR t.to_addr = ?)");
    params.push(query.address, query.address);
  }
  if (query.outcome === "landed") where.push("t.status = 1");
  if (query.outcome === "reverted") where.push("t.status <> 1");
  if (query.hours) {
    where.push("t.ts >= ?");
    params.push(now - Math.round(query.hours * 3600));
  }
  return { where: where.join(" AND "), params };
}

function price(prices: Prices, chain: ChainConfig | undefined, token: string | null): number | null {
  if (!chain || !token) return null;
  return prices.usd(chain.geckoNetwork, token);
}

export function priced(rows: QueryRow[], chains: Map<string, ChainConfig>, prices: Prices, labels: Map<string, string>): Trade[] {
  return rows.map((row) => {
    const chain = chains.get(row.chain);
    const nativeUsd = chain?.nativePriceToken ? prices.usd(chain.geckoNetwork, chain.nativePriceToken) : null;
    const gasUsd = !row.gas_ours ? 0 : nativeUsd === null ? null : row.gas_native * nativeUsd;

    const tokenUsd = price(prices, chain, row.token);
    const whole = row.net !== null && row.decimals !== null ? row.net / 10 ** row.decimals : null;
    const profitUsd = whole !== null && tokenUsd !== null ? whole * tokenUsd : null;

    return {
      chain: row.chain,
      hash: row.hash,
      from: row.from_addr,
      fromLabel: labels.get(`${row.chain}:${row.from_addr}`) ?? row.from_addr.slice(0, 8) + "…",
      to: row.to_addr,
      toLabel: row.to_addr ? (labels.get(`${row.chain}:${row.to_addr}`) ?? null) : null,
      blockNumber: row.block,
      timestamp: row.ts,
      status: row.status,
      gasUsed: row.gas_used,
      gasNative: row.gas_ours ? row.gas_native : 0,
      gasUsd,
      profitToken: row.token,
      profitSymbol: row.symbol,
      profitAmount: whole,
      profitUsd,
      netUsd: profitUsd === null || gasUsd === null ? null : profitUsd - gasUsd,
    };
  });
}

export function totals(trades: Trade[]): Totals {
  const out: Totals = { sent: 0, landed: 0, reverted: 0, grossUsd: 0, gasUsd: 0, netUsd: 0, unpriced: 0 };
  for (const trade of trades) {
    out.sent += 1;
    if (trade.status === 1) out.landed += 1;
    else out.reverted += 1;
    if (trade.gasUsd !== null) out.gasUsd += trade.gasUsd;
    if (trade.profitUsd !== null) out.grossUsd += trade.profitUsd;
    // A profit token with no price would otherwise read as no profit at all.
    else if (trade.profitAmount !== null) out.unpriced += 1;
  }
  out.netUsd = out.grossUsd - out.gasUsd;
  return out;
}

export interface Bucket {
  at: number;
  netUsd: number;
  sent: number;
  landed: number;
}

/** Buckets for the chart. `stepSeconds` is chosen by the caller from the window on screen. */
export function series(trades: Trade[], stepSeconds: number, now = Math.floor(Date.now() / 1000)): Bucket[] {
  if (trades.length === 0) return [];
  const oldest = Math.min(...trades.map((trade) => trade.timestamp));
  const first = Math.floor(oldest / stepSeconds) * stepSeconds;
  const last = Math.floor(now / stepSeconds) * stepSeconds;
  const buckets = new Map<number, Bucket>();
  // A window far wider than the chart still draws: the caller's step keeps the count sane.
  for (let at = first; at <= last; at += stepSeconds) buckets.set(at, { at, netUsd: 0, sent: 0, landed: 0 });
  for (const trade of trades) {
    const at = Math.floor(trade.timestamp / stepSeconds) * stepSeconds;
    const bucket = buckets.get(at);
    if (!bucket) continue;
    bucket.sent += 1;
    if (trade.status === 1) bucket.landed += 1;
    if (trade.netUsd !== null) bucket.netUsd += trade.netUsd;
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

/** Every token any visible trade rests in, so prices are fetched once per pass. */
export function tokensIn(rows: QueryRow[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.token) continue;
    const set = out.get(row.chain) ?? new Set<string>();
    set.add(row.token);
    out.set(row.chain, set);
  }
  return out;
}

export function loadPrices(store: Store, chains: ChainConfig[], prices: Prices, rows: QueryRow[]): Promise<void[]> {
  void store;
  const byChain = tokensIn(rows);
  return Promise.all(
    chains.map((chain) => {
      const tokens = [...(byChain.get(chain.name) ?? [])];
      if (chain.nativePriceToken) tokens.push(chain.nativePriceToken);
      return prices.load(chain.geckoNetwork, tokens);
    }),
  );
}
