import assert from "node:assert/strict";
import { test } from "node:test";
import { clauses, priced, series, totals } from "../src/api.ts";
import { Prices } from "../src/pricing.ts";
import { stepFor } from "../src/server.ts";
import type { QueryRow } from "../src/store.ts";
import type { ChainConfig, Trade } from "../src/types.ts";

const WFLR = "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d";

function chain(): ChainConfig {
  return {
    name: "flare",
    explorerUrl: "https://x/api",
    explorerSite: "https://x",
    nativeSymbol: "FLR",
    nativeDecimals: 18,
    geckoNetwork: "flare",
    nativePriceToken: WFLR,
    watched: [],
  };
}

function row(over: Partial<QueryRow> = {}): QueryRow {
  return {
    chain: "flare", hash: "0x1", from_addr: "0xaaa", to_addr: "0xbbb", block: 1, ts: 1_000_000,
    status: 1, gas_used: 21_000, gas_native: 1, gas_ours: 1,
    token: WFLR, symbol: "WFLR", decimals: 18, net: 2e18, ...over,
  };
}

function withPrice(usd: number): Prices {
  const prices = new Prices();
  (prices as unknown as { cache: Map<string, { usd: number; at: number }> }).cache.set(`flare:${WFLR}`, {
    usd,
    at: Date.now(),
  });
  return prices;
}

test("a priced row nets its profit against the gas it paid", () => {
  const chains = new Map([["flare", chain()]]);
  const [trade] = priced([row()], chains, withPrice(0.5), new Map());
  assert.equal(trade?.profitAmount, 2);
  assert.equal(trade?.profitUsd, 1);
  assert.equal(trade?.gasUsd, 0.5);
  assert.equal(trade?.netUsd, 0.5);
});

test("gas someone else paid is not ours to count", () => {
  const chains = new Map([["flare", chain()]]);
  const [trade] = priced([row({ gas_ours: 0 })], chains, withPrice(0.5), new Map());
  assert.equal(trade?.gasUsd, 0);
  assert.equal(trade?.gasNative, 0);
});

test("an unpriced token leaves the profit unknown rather than zero", () => {
  const chains = new Map([["flare", chain()]]);
  const [trade] = priced([row({ token: "0xdead", symbol: "DEAD" })], chains, withPrice(0.5), new Map());
  assert.equal(trade?.profitUsd, null);
  assert.equal(trade?.netUsd, null);
  assert.equal(totals([trade as Trade]).unpriced, 1);
});

test("totals split landed from reverted", () => {
  const chains = new Map([["flare", chain()]]);
  const trades = priced([row(), row({ hash: "0x2", status: 0, token: null, symbol: null, net: null })], chains, withPrice(0.5), new Map());
  const got = totals(trades);
  assert.equal(got.sent, 2);
  assert.equal(got.landed, 1);
  assert.equal(got.reverted, 1);
  assert.ok(Math.abs(got.netUsd - 0) < 1e-9);
});

test("clauses parameterise every filter", () => {
  const { where, params } = clauses({ chain: "flare", address: "0xaaa", outcome: "landed", hours: 1 }, 10_000);
  assert.match(where, /t\.chain = \?/);
  assert.match(where, /t\.status = 1/);
  assert.deepEqual(params, ["flare", "0xaaa", "0xaaa", 10_000 - 3600]);
});

test("an empty filter still reads as valid SQL", () => {
  assert.equal(clauses({}).where, "1 = 1");
});

test("series buckets by step and keeps empty buckets so the axis is continuous", () => {
  const chains = new Map([["flare", chain()]]);
  const trades = priced(
    [row({ ts: 1_000, net: 1e18 }), row({ hash: "0x2", ts: 9_500, net: 1e18 })],
    chains,
    withPrice(0.5),
    new Map(),
  );
  const got = series(trades, 1_000, 10_000);
  assert.equal(got.length, 10);
  assert.equal(got[5]?.sent, 0);
  assert.equal(got[8]?.sent, 1);
});

test("the bucket width keeps a window readable and never goes sub-five-minute", () => {
  assert.equal(stepFor(1), 300);
  assert.ok(stepFor(168) > stepFor(24));
});
