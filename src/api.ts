import type { Prices } from "./pricing.ts";
import type { BucketCount, BucketHeld, CountRow, HeldRow, QueryRow, Store } from "./store.ts";
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
    // Holding nothing is a real zero, not an unknown: a reverted transaction moved no token and
    // still paid its gas, so its net is the gas back. Only a token that has no price is unknown,
    // and that stays null rather than reading as a transaction that earned nothing.
    const profitUsd = whole === null ? 0 : tokenUsd === null ? null : whole * tokenUsd;

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

/**
 * Totals over every matching row, not over the page the table shows. Gas is valued per chain, since
 * each chain's gas is denominated in its own token.
 */
export function totals(counts: CountRow[], held: HeldRow[], chains: Map<string, ChainConfig>, prices: Prices): Totals {
  const out: Totals = { sent: 0, landed: 0, reverted: 0, grossUsd: 0, gasUsd: 0, netUsd: 0, unpriced: 0 };
  for (const row of counts) {
    out.sent += row.sent;
    out.landed += row.landed;
    out.reverted += row.sent - row.landed;
    const chain = chains.get(row.chain);
    const nativeUsd = chain?.nativePriceToken ? prices.usd(chain.geckoNetwork, chain.nativePriceToken) : null;
    if (nativeUsd !== null) out.gasUsd += row.gas_native * nativeUsd;
  }
  for (const row of held) {
    const usd = price(prices, chains.get(row.chain), row.token);
    // A token with no price would otherwise read as no profit at all.
    if (usd === null) out.unpriced += row.trades;
    else out.grossUsd += (row.net / 10 ** row.decimals) * usd;
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

/**
 * Chart buckets over every matching row. Empty buckets between the first and last are filled so the
 * time axis stays continuous rather than closing the gaps.
 */
export function series(
  counts: BucketCount[],
  held: BucketHeld[],
  chains: Map<string, ChainConfig>,
  prices: Prices,
  stepSeconds: number,
): Bucket[] {
  if (counts.length === 0) return [];
  const buckets = new Map<number, Bucket>();
  const at = (key: number): Bucket => {
    const found = buckets.get(key) ?? { at: key, netUsd: 0, sent: 0, landed: 0 };
    buckets.set(key, found);
    return found;
  };

  for (const row of counts) {
    const bucket = at(row.at);
    bucket.sent += row.sent;
    bucket.landed += row.landed;
    const chain = chains.get(row.chain);
    const nativeUsd = chain?.nativePriceToken ? prices.usd(chain.geckoNetwork, chain.nativePriceToken) : null;
    if (nativeUsd !== null) bucket.netUsd -= row.gas_native * nativeUsd;
  }
  for (const row of held) {
    const usd = price(prices, chains.get(row.chain), row.token);
    if (usd !== null) at(row.at).netUsd += (row.net / 10 ** row.decimals) * usd;
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  // Bounded: a year at a five-minute step would be a hundred thousand bars nobody can read.
  if ((last - first) / stepSeconds < 5_000) {
    for (let key = first; key <= last; key += stepSeconds) at(key);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

/** Bounds on the net USD column, which is the one filter SQL cannot apply. */
export interface Bounds {
  min?: number;
  max?: number;
}

export function bounded(bounds: Bounds): boolean {
  return bounds.min !== undefined || bounds.max !== undefined;
}

/**
 * Trades whose net falls inside the bounds.
 *
 * Net is priced at request time from prices that live in memory, never in the database, so this
 * cannot be a WHERE clause and cannot be counted by SQL — the rows have to be valued before it is
 * known which of them match. A trade whose net is unknown, because it holds a token with no price,
 * is left out rather than guessed either side of the bound.
 */
export function withinBounds(trades: Trade[], bounds: Bounds): Trade[] {
  if (!bounded(bounds)) return trades;
  return trades.filter((trade) => {
    if (trade.netUsd === null) return false;
    if (bounds.min !== undefined && trade.netUsd < bounds.min) return false;
    if (bounds.max !== undefined && trade.netUsd > bounds.max) return false;
    return true;
  });
}

/** Every token any matching trade rests in, so prices are fetched once per request. */
export function tokensIn(rows: { chain: string; token: string | null }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.token) continue;
    const set = out.get(row.chain) ?? new Set<string>();
    set.add(row.token);
    out.set(row.chain, set);
  }
  return out;
}

export function loadPrices(chains: ChainConfig[], prices: Prices, ...sets: { chain: string; token: string | null }[][]): Promise<void[]> {
  const byChain = tokensIn(sets.flat());
  return Promise.all(
    chains.map((chain) => {
      const tokens = [...(byChain.get(chain.name) ?? [])];
      if (chain.nativePriceToken) tokens.push(chain.nativePriceToken);
      return prices.load(chain.geckoNetwork, tokens);
    }),
  );
}
