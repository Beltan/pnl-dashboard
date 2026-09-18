import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { Prices } from "./pricing.ts";
import { Store } from "./store.ts";
import { Sync } from "./sync.ts";
import { serve } from "./server.ts";

let config;
try {
  config = loadConfig();
} catch (error) {
  log.error("Configuration is not usable", { error: (error as Error).message });
  process.exit(1);
}

mkdirSync(dirname(config.dbPath), { recursive: true });
const store = new Store(config.dbPath);
const prices = new Prices();
const sync = new Sync(config, store);

const held = store.stats();
log.info("Store opened", { path: config.dbPath, ...held });
if (held.trades === 0) log.info("No history yet; the first pass backfills every watched address from its first transaction");

sync.start();
const server = serve(config, store, sync, prices);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("Shutting down", { signal });
    sync.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
