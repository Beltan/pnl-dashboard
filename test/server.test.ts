import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Prices } from "../src/pricing.ts";
import { createDashboard } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Sync } from "../src/sync.ts";
import type { AppConfig } from "../src/types.ts";

const WFLR = "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d";
const TOKEN = "0xe7cd86e13ac4309349f30b3435a9d337750fc82d";
const CONTRACT = "0x3417afa3b5487b3abcd4fe55f83f4d3e53750d71";

function config(): AppConfig {
  return {
    port: 0, host: "127.0.0.1", user: "admin", password: "", windowHours: 0, refreshSeconds: 60,
    dbPath: ":memory:",
    chains: [{
      name: "flare", explorerUrl: "http://x/api", explorerSite: "http://x",
      nativeSymbol: "FLR", nativeDecimals: 18, geckoNetwork: "test", nativePriceToken: WFLR,
      watched: [{ address: CONTRACT, label: "Contract" }],
    }],
  };
}

/** Prices without a network: seeded directly, so no request leaves the test. */
function prices(): Prices {
  const held = new Prices();
  const cache = (held as unknown as { cache: Map<string, { usd: number; at: number }> }).cache;
  cache.set(`test:${WFLR}`, { usd: 0.02, at: Date.now() });
  cache.set(`test:${TOKEN}`, { usd: 1, at: Date.now() });
  return held;
}

/**
 * Sixty trades, newest first by construction. Every fourth is reverted, so it holds nothing.
 *
 * Sixty because the page sizes the server offers start at 25: fewer rows would be a single page
 * and would not exercise paging at all.
 */
function seeded(count = 60): Store {
  const store = new Store(":memory:");
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < count; i++) {
    const hash = "0x" + String(i).padStart(4, "0");
    const reverted = i % 4 === 0;
    store.putTrades([{
      chain: "flare", hash, from: CONTRACT, to: CONTRACT, block: i, ts: now - i * 60,
      status: reverted ? 0 : 1, gasUsed: 21_000, gasNative: 1, gasOurs: true,
    }]);
    if (!reverted) {
      store.putTransfers([{
        chain: "flare", hash, token: TOKEN, symbol: "USDT", decimals: 18,
        from: "0xpool", to: CONTRACT, value: String(i), delta: (i + 1) * 1e18,
      }]);
    }
  }
  return store;
}

async function serving(store: Store) {
  const held = config();
  const server = createDashboard(held, store, new Sync(held, store), prices());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    get: async (qs: string) => (await fetch(`http://127.0.0.1:${port}/api/trades${qs}`)).json() as Promise<any>,
    close: () => server.close(),
  };
}

test("pages cover every row exactly once, with no overlap and nothing skipped", async () => {
  const api = await serving(seeded());
  try {
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const body = await api.get(`?hours=0&size=25&page=${page}`);
      assert.equal(body.total, 60);
      assert.equal(body.totalPages, 3);
      assert.equal(body.pageSize, 25);
      assert.equal(body.trades.length, page === 3 ? 10 : 25);
      seen.push(...body.trades.map((t: { hash: string }) => t.hash));
    }
    assert.equal(seen.length, 60, "every row appears");
    assert.equal(new Set(seen).size, 60, "and none of them twice");

    const all = await api.get("?hours=0&size=250&page=1");
    assert.deepEqual(seen, all.trades.map((t: { hash: string }) => t.hash), "paging preserves the order");
  } finally {
    api.close();
  }
});

test("the totals describe the window, not the page being looked at", async () => {
  const api = await serving(seeded());
  try {
    const first = await api.get("?hours=0&size=25&page=1");
    const third = await api.get("?hours=0&size=25&page=3");
    assert.deepEqual(first.totals, third.totals, "the tiles must not change as you page");
    assert.equal(first.totals.sent, 60);
    assert.equal(first.totals.reverted, 15);
  } finally {
    api.close();
  }
});

test("asking past the last page lands on the last page rather than an empty one", async () => {
  const api = await serving(seeded());
  try {
    const body = await api.get("?hours=0&size=25&page=99");
    assert.equal(body.page, 3, "clamped to the last page that has rows");
    assert.equal(body.trades.length, 10);
  } finally {
    api.close();
  }
});

test("a net bound narrows the table and repages it", async () => {
  const api = await serving(seeded());
  try {
    // Reverted trades hold nothing and paid 1 FLR of gas at $0.02, so their net is exactly -0.02.
    const losses = await api.get("?hours=0&size=25&page=1&maxNet=0");
    assert.equal(losses.total, 15, "only the reverted trades are at or below zero");
    assert.ok(losses.trades.every((t: { netUsd: number }) => t.netUsd <= 0));
    assert.ok(losses.trades.every((t: { netUsd: number }) => t.netUsd === -0.02));

    const wins = await api.get("?hours=0&size=25&page=1&minNet=10");
    assert.ok(wins.total > 0 && wins.total < 60, "a bound in the middle keeps some and drops some");
    assert.ok(wins.trades.every((t: { netUsd: number }) => t.netUsd >= 10));

    // The window totals stay whole even while the table is narrowed.
    assert.equal(losses.totals.sent, 60);
  } finally {
    api.close();
  }
});

test("a bounded table still pages", async () => {
  const api = await serving(seeded());
  try {
    // 45 of the 60 landed and hold a priced token, so a lower bound of zero still spans two pages.
    const first = await api.get("?hours=0&size=25&page=1&minNet=0");
    const second = await api.get("?hours=0&size=25&page=2&minNet=0");
    assert.equal(first.total, 45);
    assert.equal(first.totalPages, 2);
    assert.equal(first.trades.length, 25);
    assert.equal(second.trades.length, 20);
    assert.notDeepEqual(
      first.trades.map((t: { hash: string }) => t.hash),
      second.trades.map((t: { hash: string }) => t.hash),
      "the second page is not the first one again",
    );
  } finally {
    api.close();
  }
});
