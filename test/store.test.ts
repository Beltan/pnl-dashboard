import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";

const CONTRACT = "0x3417afa3b5487b3abcd4fe55f83f4d3e53750d71";
const POOL = "0x5ed30e42757e3edd2f898fbca26cd7c6f391ae1c";
const WFLR = "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d";
const USDT = "0xe7cd86e13ac4309349f30b3435a9d337750fc82d";

function store(): Store {
  return new Store(":memory:");
}

function trade(db: Store, hash: string, over: Record<string, unknown> = {}): void {
  db.putTrades([
    {
      chain: "flare", hash, from: "0xwallet", to: CONTRACT, block: 1, ts: 1000,
      status: 1, gasUsed: 100, gasNative: 1, gasOurs: true, ...over,
    } as never,
  ]);
}

function leg(db: Store, hash: string, token: string, from: string, to: string, value: string, delta: number): void {
  db.putTransfers([
    { chain: "flare", hash, token, symbol: "T", decimals: 18, from, to, value, delta },
  ]);
}

test("a round trip reports the one token it was left holding", () => {
  const db = store();
  trade(db, "0xa");
  // 100 WFLR out and back plus 5 kept; USDT passes through and nets to zero.
  leg(db, "0xa", WFLR, POOL, CONTRACT, "105", 105);
  leg(db, "0xa", WFLR, CONTRACT, POOL, "100", -100);
  leg(db, "0xa", USDT, POOL, CONTRACT, "64", 64);
  leg(db, "0xa", USDT, CONTRACT, POOL, "64", -64);

  const rows = db.query("t.chain = ?", ["flare"], 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.token, WFLR);
  assert.equal(rows[0]?.net, 5);
  db.close();
});

test("a transaction that kept nothing reports no token", () => {
  const db = store();
  trade(db, "0xb");
  leg(db, "0xb", WFLR, CONTRACT, POOL, "100", -100);
  const rows = db.query("t.chain = ?", ["flare"], 10);
  assert.equal(rows[0]?.token, null);
  assert.equal(rows[0]?.net, null);
  db.close();
});

test("the same movement seen from two addresses is stored once", () => {
  const db = store();
  trade(db, "0xc");
  leg(db, "0xc", WFLR, POOL, CONTRACT, "7", 7);
  leg(db, "0xc", WFLR, POOL, CONTRACT, "7", 7);
  assert.equal(db.query("t.chain = ?", ["flare"], 10)[0]?.net, 7);
  assert.equal(db.stats().transfers, 1);
  db.close();
});

test("re-reading a boundary block updates rather than duplicating", () => {
  const db = store();
  trade(db, "0xd");
  trade(db, "0xd", { status: 0 });
  const rows = db.query("t.chain = ?", ["flare"], 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 0);
  db.close();
});

test("cursors start at zero and carry the block they reached", () => {
  const db = store();
  assert.equal(db.cursor("flare", CONTRACT, "txlist"), 0);
  db.setCursor("flare", CONTRACT, "txlist", 70_000_000);
  assert.equal(db.cursor("flare", CONTRACT, "txlist"), 70_000_000);
  // Actions keep their own place, so one falling behind does not drag the other back.
  assert.equal(db.cursor("flare", CONTRACT, "tokentx"), 0);
  db.close();
});

test("raw amounts past 2^53 keep their magnitude", () => {
  const db = store();
  trade(db, "0xe");
  // 698,038 WFLR at 18 decimals.
  leg(db, "0xe", WFLR, POOL, CONTRACT, "698038444933888744637544", 6.98038444933888744637544e23);
  const net = db.query("t.chain = ?", ["flare"], 10)[0]?.net ?? 0;
  assert.ok(Math.abs(net / 1e18 - 698_038.44) < 1, String(net));
  db.close();
});
