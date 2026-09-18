import assert from "node:assert/strict";
import { test } from "node:test";
import { clauses, priced, series, totals, withinBounds } from "../src/api.ts";
import { Prices } from "../src/pricing.ts";
import { pageFrom, pageSizeFrom, stepFor } from "../src/server.ts";
import type { QueryRow } from "../src/store.ts";
import type { ChainConfig } from "../src/types.ts";

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
});

test("totals come from the aggregate, not from the capped page", () => {
  const chains = new Map([["flare", chain()]]);
  const got = totals(
    [{ chain: "flare", sent: 50_000, landed: 30_000, gas_native: 2 }],
    [{ chain: "flare", token: WFLR, symbol: "WFLR", decimals: 18, net: 10e18, trades: 30_000 }],
    chains,
    withPrice(0.5),
  );
  assert.equal(got.sent, 50_000);
  assert.equal(got.landed, 30_000);
  assert.equal(got.reverted, 20_000);
  assert.equal(got.grossUsd, 5);
  assert.equal(got.gasUsd, 1);
  assert.equal(got.netUsd, 4);
});

test("an unpriced token is counted rather than valued at zero", () => {
  const chains = new Map([["flare", chain()]]);
  const got = totals(
    [{ chain: "flare", sent: 3, landed: 3, gas_native: 0 }],
    [{ chain: "flare", token: "0xdead", symbol: "DEAD", decimals: 18, net: 1e18, trades: 3 }],
    chains,
    withPrice(0.5),
  );
  assert.equal(got.unpriced, 3);
  assert.equal(got.grossUsd, 0);
});

test("each chain's gas is valued in its own token", () => {
  const avax = { ...chain(), name: "avax", geckoNetwork: "avax", nativePriceToken: "0xwavax" };
  const chains = new Map([["flare", chain()], ["avax", avax]]);
  const prices = withPrice(0.5);
  (prices as unknown as { cache: Map<string, { usd: number; at: number }> }).cache.set("avax:0xwavax", { usd: 8, at: Date.now() });
  const got = totals(
    [{ chain: "flare", sent: 1, landed: 1, gas_native: 2 }, { chain: "avax", sent: 1, landed: 1, gas_native: 2 }],
    [],
    chains,
    prices,
  );
  // 2 FLR at 0.5 plus 2 AVAX at 8, never one rate over both.
  assert.equal(got.gasUsd, 17);
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

test("series fills the gap between buckets so the axis stays continuous", () => {
  const chains = new Map([["flare", chain()]]);
  const got = series(
    [
      { at: 1_000, chain: "flare", sent: 1, landed: 1, gas_native: 0 },
      { at: 9_000, chain: "flare", sent: 1, landed: 0, gas_native: 0 },
    ],
    [{ at: 1_000, chain: "flare", token: WFLR, symbol: "WFLR", decimals: 18, net: 2e18 }],
    chains,
    withPrice(0.5),
    1_000,
  );
  assert.equal(got.length, 9);
  assert.equal(got[0]?.netUsd, 1);
  assert.equal(got[5]?.sent, 0);
  assert.equal(got[8]?.sent, 1);
});

test("gas pulls a bucket negative when nothing was earned in it", () => {
  const chains = new Map([["flare", chain()]]);
  const got = series([{ at: 1_000, chain: "flare", sent: 4, landed: 0, gas_native: 2 }], [], chains, withPrice(0.5), 1_000);
  assert.equal(got[0]?.netUsd, -1);
});

test("the bucket width keeps a window readable and never goes sub-five-minute", () => {
  assert.equal(stepFor(1), 300);
  assert.ok(stepFor(168) > stepFor(24));
});

test("a reverted transaction reports the gas it burned as a loss", () => {
  // Reverted: no token movement survived, so the join leaves it holding nothing.
  const [trade] = priced([row({ status: 0, token: null, symbol: null, decimals: null, net: null })],
    new Map([["flare", chain()]]), withPrice(0.02), new Map());

  assert.equal(trade!.profitUsd, 0, "holding nothing is nothing gained, not an unknown");
  assert.equal(trade!.netUsd, -0.02, "the gas is still paid, so the net is negative");
});

test("a landed transaction that kept nothing is also a loss, not a blank", () => {
  const [trade] = priced([row({ status: 1, token: null, symbol: null, decimals: null, net: null })],
    new Map([["flare", chain()]]), withPrice(0.02), new Map());

  assert.equal(trade!.netUsd, -0.02);
});

test("gas paid by someone else costs a reverted transaction nothing", () => {
  const [trade] = priced([row({ status: 0, gas_ours: 0, token: null, symbol: null, decimals: null, net: null })],
    new Map([["flare", chain()]]), withPrice(0.02), new Map());

  assert.equal(trade!.netUsd, 0, "a revert we did not pay for is not our loss");
});

test("a held token with no price stays unknown rather than reading as zero", () => {
  const [trade] = priced([row({ status: 1 })], new Map([["flare", chain()]]), new Prices(), new Map());

  assert.equal(trade!.profitUsd, null, "an unpriced token is not a transaction that earned nothing");
  assert.equal(trade!.netUsd, null);
});

test("net bounds keep the trades inside them", () => {
  const trades = [
    { netUsd: -5 }, { netUsd: -0.5 }, { netUsd: 0 }, { netUsd: 3 }, { netUsd: null },
  ] as never as Parameters<typeof withinBounds>[0];

  assert.deepEqual(withinBounds(trades, { min: 0 }).map((t) => t.netUsd), [0, 3]);
  assert.deepEqual(withinBounds(trades, { max: 0 }).map((t) => t.netUsd), [-5, -0.5, 0]);
  assert.deepEqual(withinBounds(trades, { min: -1, max: 1 }).map((t) => t.netUsd), [-0.5, 0]);
});

test("a bound of zero is a bound, and no bound leaves every row alone", () => {
  const trades = [{ netUsd: -5 }, { netUsd: null }] as never as Parameters<typeof withinBounds>[0];

  assert.equal(withinBounds(trades, {}).length, 2, "an unset bound must not drop the unpriced row");
  assert.equal(withinBounds(trades, { max: 0 }).length, 1, "zero is a real bound, not an empty one");
});

test("a trade whose net is unknown is left out of a bounded table", () => {
  const trades = [{ netUsd: null }] as never as Parameters<typeof withinBounds>[0];
  assert.equal(withinBounds(trades, { min: -1e9 }).length, 0, "an unknown net cannot be claimed to match");
});

test("a page is clamped to what the result actually has", () => {
  assert.equal(pageFrom(1, 0, 50), 1, "an empty result still has a first page");
  assert.equal(pageFrom(3, 7128, 50), 3);
  assert.equal(pageFrom(999, 7128, 50), 143, "past the end lands on the last page");
  assert.equal(pageFrom(0, 7128, 50), 1);
  assert.equal(pageFrom(-4, 7128, 50), 1);
  assert.equal(pageFrom(NaN, 7128, 50), 1, "a junk page parameter is page one, not a crash");
});

test("only the offered page sizes are honoured", () => {
  const size = (raw: string) => pageSizeFrom(new URL("http://x/api/trades?size=" + raw));
  assert.equal(size("25"), 25);
  assert.equal(size("250"), 250);
  assert.equal(size("10000"), 50, "an unoffered size falls back rather than paging the whole table");
  assert.equal(size("junk"), 50);
});
