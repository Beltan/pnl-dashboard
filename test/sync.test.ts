import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { Sync } from "../src/sync.ts";
import type { AppConfig } from "../src/types.ts";

const ADDRESS = "0x3417afa3b5487b3abcd4fe55f83f4d3e53750d71";

function config(explorerUrl: string, confirmBlocks = 0): AppConfig {
  return {
    port: 0, host: "127.0.0.1", user: "admin", password: "", windowHours: 24, refreshSeconds: 60, confirmBlocks,
    dbPath: ":memory:",
    chains: [{
      name: "flare", explorerUrl, explorerSite: "http://127.0.0.1:9",
      nativeSymbol: "FLR", nativeDecimals: 18, geckoNetwork: "", nativePriceToken: "",
      watched: [{ address: ADDRESS, label: "Contract" }],
    }],
  };
}

/** A stand-in explorer, so a pass can be run without reaching the network. */
async function explorer(answer: (url: URL) => { status: number; body: unknown }) {
  const server = createServer((request, response) => {
    const { status, body } = answer(new URL(request.url ?? "/", "http://127.0.0.1"));
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api`, close: () => server.close() };
}

test("an explorer that never answers leaves the chain unsynced and carrying the reason", async () => {
  // Port 9 is the discard port: the connection is refused rather than hanging.
  const sync = new Sync(config("http://127.0.0.1:9/api"), new Store(":memory:"));
  await sync.pass();

  const held = sync.snapshot().get("flare")!;
  assert.equal(held.syncedAt, null, "a pass that read nothing is not a sync");
  assert.notEqual(held.error, null, "the failure has to reach the chain state");
  assert.match(held.error!, /txlist/, "and say which endpoint it was");
});

test("an explorer that starts failing part way through stops counting as synced", async () => {
  let failing = false;
  const server = await explorer(() =>
    failing ? { status: 502, body: { message: "Bad Gateway" } } : { status: 200, body: { status: "0", message: "No transactions found", result: [] } },
  );
  try {
    const sync = new Sync(config(server.url), new Store(":memory:"));
    await sync.pass();
    const first = { ...sync.snapshot().get("flare")! };
    assert.equal(first.error, null);
    assert.notEqual(first.syncedAt, null, "an empty history read to the end is a complete pass");
    assert.equal(first.backfilling, false);

    failing = true;
    await sync.pass();
    const second = sync.snapshot().get("flare")!;
    assert.match(second.error!, /502/, "the pass that failed says so");
    assert.equal(second.syncedAt, first.syncedAt, "syncedAt stays at the last pass that completed");
  } finally {
    server.close();
  }
});

test("a failure says what actually went wrong, not just that fetch failed", async () => {
  // A name that cannot resolve, which is what a container without a working resolver sees.
  const sync = new Sync(config("http://nonexistent.invalid/api"), new Store(":memory:"));
  await sync.pass();

  const held = sync.snapshot().get("flare")!;
  assert.doesNotMatch(held.error!, /^.*txlist: TypeError: fetch failed;/, "the wrapper alone is not a reason");
  assert.match(held.error!, /EAI_AGAIN|ENOTFOUND|getaddrinfo/, "the DNS failure has to be visible");
});

const POOL = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
/** Recent enough for a repair pass to look at it. */
const NOW = Math.floor(Date.now() / 1000) - 600;

const tx = (block: number, hash: string) => ({
  hash, from: ADDRESS, to: POOL, blockNumber: String(block), timeStamp: String(NOW + block),
  txreceipt_status: "1", isError: "0", gasUsed: "100000", gasPrice: "25000000000",
});
const transfer = (block: number, hash: string) => ({
  hash, from: POOL, to: ADDRESS, blockNumber: String(block), timeStamp: String(NOW + block),
  contractAddress: TOKEN, value: "5000000000000000000", tokenSymbol: "WFLR", tokenDecimal: "18",
});

/**
 * An explorer that has the later block's transfers indexed before the earlier one's, which is what
 * a cursor parked on the high-water mark steps over.
 */
async function outOfOrder(late: number[]) {
  let reads = 0;
  const rows = (action: string | null, start: number) => {
    if (action === "txlist") return [tx(100, "0xaa"), tx(200, "0xbb")].filter((r) => Number(r.blockNumber) >= start);
    reads++;
    const all = reads === 1 ? [transfer(200, "0xbb")] : late.map((block) => transfer(block, block === 100 ? "0xaa" : "0xbb"));
    return all.filter((r) => Number(r.blockNumber) >= start);
  };
  const server = await explorer((url) => ({
    status: 200,
    body: { status: "1", message: "OK", result: rows(url.searchParams.get("action"), Number(url.searchParams.get("startblock"))) },
  }));
  return server;
}

test("a transfer the explorer indexes late is still found", async () => {
  const server = await outOfOrder([100, 200]);
  try {
    const store = new Store(":memory:");
    // The confirmation window is off, so this is the repair pass alone doing the healing.
    const sync = new Sync(config(server.url), store);
    await sync.pass();

    const first = store.query("1 = 1", [], 50).find((row) => row.hash === "0xaa")!;
    assert.equal(first.symbol, null, "the block-100 transfer was not indexed yet, so nothing is held");

    // The second pass is the first that repairs, since the first was still a backfill; the third
    // is the walk reading the block the repair rewound onto.
    await sync.pass();
    await sync.pass();
    const healed = store.query("1 = 1", [], 50).find((row) => row.hash === "0xaa")!;
    assert.equal(healed.symbol, "WFLR", "once the explorer has it, the trade holds its profit again");
  } finally {
    server.close();
  }
});

test("the confirmation window keeps the cursor short of the highest block it read", async () => {
  const server = await outOfOrder([100, 200]);
  try {
    const store = new Store(":memory:");
    await new Sync(config(server.url, 150), store).pass();
    assert.equal(store.cursor("flare", ADDRESS, "txlist"), 50, "200 read, 150 held back");
  } finally {
    server.close();
  }
});

test("a landed transaction that really moved no token is only chased once", async () => {
  // Block 100's transfer never arrives: a transaction that paid gas and moved nothing.
  const server = await outOfOrder([200]);
  try {
    const store = new Store(":memory:");
    const sync = new Sync(config(server.url), store);
    // Backfill, then the repair that rewinds onto block 100, then the walk that finds nothing there.
    await sync.pass();
    await sync.pass();
    await sync.pass();

    assert.equal(store.cursor("flare", ADDRESS, "tokentx"), 200, "the walk is back at the tip");
    await sync.pass();
    assert.equal(store.cursor("flare", ADDRESS, "tokentx"), 200, "and a further pass does not rewind again");
  } finally {
    server.close();
  }
});
