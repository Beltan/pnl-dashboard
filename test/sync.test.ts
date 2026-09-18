import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { Sync } from "../src/sync.ts";
import type { AppConfig } from "../src/types.ts";

const ADDRESS = "0x3417afa3b5487b3abcd4fe55f83f4d3e53750d71";

function config(explorerUrl: string): AppConfig {
  return {
    port: 0, host: "127.0.0.1", user: "admin", password: "", windowHours: 24, refreshSeconds: 60,
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
