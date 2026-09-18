import assert from "node:assert/strict";
import { test } from "node:test";
import { filter, series, totals } from "../src/api.ts";
import { stepFor } from "../src/server.ts";
import type { Trade } from "../src/types.ts";

function trade(over: Partial<Trade>): Trade {
  return {
    chain: "flare",
    hash: "0x1",
    from: "0xaaa",
    fromLabel: "wallet",
    to: "0xbbb",
    blockNumber: 1,
    timestamp: 1_000_000,
    status: 1,
    gasUsed: 21_000,
    effectiveGasPrice: "1",
    gasNative: 0.001,
    gasUsd: 0.01,
    profitToken: "0xccc",
    profitSymbol: "WFLR",
    profitRaw: "1",
    profitUsd: 0.05,
    netUsd: 0.04,
    ...over,
  };
}

test("totals split landed from reverted and net out gas", () => {
  const got = totals([trade({}), trade({ status: 0, profitUsd: null, profitRaw: null, netUsd: null })]);
  assert.equal(got.sent, 2);
  assert.equal(got.landed, 1);
  assert.equal(got.reverted, 1);
  assert.ok(Math.abs(got.grossUsd - 0.05) < 1e-9);
  assert.ok(Math.abs(got.gasUsd - 0.02) < 1e-9);
  assert.ok(Math.abs(got.netUsd - 0.03) < 1e-9);
});

test("a profit token with no price is counted, not valued at zero", () => {
  const got = totals([trade({ profitUsd: null, netUsd: null, profitRaw: "500" })]);
  assert.equal(got.unpriced, 1);
  assert.equal(got.grossUsd, 0);
});

test("filters narrow by chain, address and outcome", () => {
  const rows = [trade({}), trade({ chain: "avax" }), trade({ status: 0 }), trade({ from: "0xzzz" })];
  assert.equal(filter(rows, { chain: "flare" }).length, 3);
  assert.equal(filter(rows, { outcome: "reverted" }).length, 1);
  assert.equal(filter(rows, { address: "0xzzz" }).length, 1);
});

test("series buckets by step and keeps empty buckets so the axis is continuous", () => {
  const now = 10_000;
  const rows = [trade({ timestamp: 1_000, netUsd: 1 }), trade({ timestamp: 9_500, netUsd: -2 })];
  const got = series(rows, 1_000, now);
  // Buckets 1000..10000 inclusive, one per step, the last one being the bucket `now` falls in.
  assert.equal(got.length, 10);
  assert.equal(got[0]?.netUsd, 1);
  assert.equal(got[8]?.netUsd, -2);
  assert.equal(got[5]?.netUsd, 0);
  assert.equal(got[9]?.sent, 0);
});

test("the bucket width keeps a window readable and never goes sub-minute", () => {
  assert.ok(stepFor(1) >= 300);
  assert.ok(stepFor(168) > stepFor(24));
});
