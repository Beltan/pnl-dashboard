import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, parseWatched } from "../src/config.ts";

const WALLET = "0x0d64fab725c4bdb0afa1115560eb19ad3a8e47a6";
const CONTRACT = "0x3417afa3b5487b3abcd4fe55f83f4d3e53750d71";

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CHAINS: "flare",
    FLARE_EXPLORER_URL: "https://flare-explorer.flare.network/api",
    FLARE_ADDRESSES: WALLET + ":Arb wallet," + CONTRACT + ":FlashSwap",
    ...over,
  };
}

test("addresses take an optional label and default to a short form", () => {
  const watched = parseWatched(WALLET + ":Arb wallet," + CONTRACT);
  assert.equal(watched.length, 2);
  assert.equal(watched[0]?.label, "Arb wallet");
  assert.equal(watched[1]?.label, "0x3417…0d71");
});

test("a malformed address fails the boot rather than being skipped", () => {
  assert.throws(() => parseWatched("0xnothex"), /not an address/);
});

test("the same address twice is kept once", () => {
  assert.equal(parseWatched(WALLET + "," + WALLET).length, 1);
});

test("a chain reads its own prefixed variables", () => {
  const config = loadConfig(env());
  assert.equal(config.chains.length, 1);
  assert.equal(config.chains[0]?.name, "flare");
  assert.equal(config.chains[0]?.watched.length, 2);
  assert.equal(config.chains[0]?.explorerSite, "https://flare-explorer.flare.network");
});

test("a missing variable names itself", () => {
  const broken = env();
  delete broken.FLARE_EXPLORER_URL;
  assert.throws(() => loadConfig(broken), /FLARE_EXPLORER_URL is not set/);
});

test("a second chain needs its own block of variables", () => {
  assert.throws(() => loadConfig(env({ CHAINS: "flare,avax" })), /AVAX_[A-Z_]+ is not set/);
});

test("defaults stand where the operator says nothing", () => {
  const config = loadConfig(env());
  assert.equal(config.port, 8080);
  assert.equal(config.windowHours, 24);
  assert.equal(config.refreshSeconds, 60);
});
