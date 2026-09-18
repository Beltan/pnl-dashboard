import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { Poller } from "./poller.ts";
import { serve } from "./server.ts";

let config;
try {
  config = loadConfig();
} catch (error) {
  log.error("Configuration is not usable", { error: (error as Error).message });
  process.exit(1);
}

const poller = new Poller(config);
poller.start();
const server = serve(config, poller);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("Shutting down", { signal });
    poller.stop();
    server.close(() => process.exit(0));
  });
}
