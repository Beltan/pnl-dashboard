import assert from "node:assert/strict";
import { test } from "node:test";
import { keptBy, toWhole, gasNative } from "../src/chain/pnl.ts";
import type { Receipt } from "../src/chain/rpc.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CONTRACT = "0x3417afa3b5487b3abcd4fe55f83f4d3e53750d71";
const POOL = "0x5ed30e42757e3edd2f898fbca26cd7c6f391ae1c";
const WFLR = "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d";
const USDT = "0xe7cd86e13ac4309349f30b3435a9d337750fc82d";

function pad(address: string): string {
  return "0x" + "0".repeat(24) + address.slice(2);
}

function transfer(token: string, from: string, to: string, value: bigint) {
  return { address: token, topics: [TRANSFER, pad(from), pad(to)], data: "0x" + value.toString(16).padStart(64, "0") };
}

function receipt(logs: Receipt["logs"]): Receipt {
  return {
    transactionHash: "0xabc",
    blockNumber: "0x1",
    status: "0x1",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    from: CONTRACT,
    to: POOL,
    logs,
  };
}

const holders = new Set([CONTRACT]);

test("a round trip leaves its surplus in one token", () => {
  // Borrow 100 WFLR, sell for USDT, buy back 105 WFLR, repay 100. Five stay behind.
  const kept = keptBy(
    receipt([
      transfer(WFLR, POOL, CONTRACT, 100n),
      transfer(WFLR, CONTRACT, POOL, 100n),
      transfer(USDT, POOL, CONTRACT, 64n),
      transfer(USDT, CONTRACT, POOL, 64n),
      transfer(WFLR, POOL, CONTRACT, 5n),
    ]),
    holders,
  );
  assert.deepEqual(kept, { token: WFLR, raw: 5n });
});

test("a transaction that keeps nothing reports nothing", () => {
  const kept = keptBy(receipt([transfer(WFLR, CONTRACT, POOL, 100n)]), holders);
  assert.equal(kept, null);
});

test("transfers between other parties are ignored", () => {
  const kept = keptBy(receipt([transfer(WFLR, POOL, POOL, 1000n)]), holders);
  assert.equal(kept, null);
});

test("the largest positive delta wins when several tokens rest", () => {
  const kept = keptBy(
    receipt([transfer(WFLR, POOL, CONTRACT, 5n), transfer(USDT, POOL, CONTRACT, 9n)]),
    holders,
  );
  assert.equal(kept?.token, USDT);
});

test("a log that is not a Transfer is skipped", () => {
  const odd = { address: WFLR, topics: ["0xdeadbeef", pad(POOL), pad(CONTRACT)], data: "0x01" };
  assert.equal(keptBy(receipt([odd]), holders), null);
});

test("raw units convert without losing the fraction", () => {
  assert.equal(toWhole(1_500_000n, 6), 1.5);
  assert.equal(toWhole(10n ** 18n, 18), 1);
  // Far past 2^53 raw units, where a naive Number(raw) would lose precision.
  assert.ok(Math.abs(toWhole(698_038_444_933_888_744_637_544n, 18) - 698_038.444933) < 1e-3);
});

test("gas is the product of what was used and what it cost", () => {
  assert.equal(gasNative(1_000_000n, 1_000_000_000_000n, 18), 1);
});
