import type { Totals, Trade } from "./types.ts";

export interface Query {
  chain?: string;
  address?: string;
  outcome?: "landed" | "reverted";
  hours?: number;
}

export function filter(trades: Trade[], query: Query): Trade[] {
  const since = query.hours ? Math.floor(Date.now() / 1000) - query.hours * 3600 : null;
  return trades.filter((trade) => {
    if (query.chain && trade.chain !== query.chain) return false;
    if (query.address && trade.from !== query.address) return false;
    if (query.outcome === "landed" && trade.status !== 1) return false;
    if (query.outcome === "reverted" && trade.status === 1) return false;
    if (since !== null && trade.timestamp < since) return false;
    return true;
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
    else if (trade.profitRaw !== null) out.unpriced += 1;
  }
  out.netUsd = out.grossUsd - out.gasUsd;
  return out;
}

export interface Bucket {
  /** Unix seconds at the start of the bucket. */
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
