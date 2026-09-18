import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authenticated, authorised } from "./auth.ts";
import { clauses, loadPrices, priced, series, totals, type Query } from "./api.ts";
import { log } from "./log.ts";
import { page } from "./page.ts";
import type { Prices } from "./pricing.ts";
import type { Store } from "./store.ts";
import type { Sync } from "./sync.ts";
import type { AppConfig } from "./types.ts";

/** Rows returned to the page. Beyond this the table stops being readable anyway. */
const MAX_ROWS = 2_000;

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function queryFrom(url: URL): Query {
  const query: Query = {};
  const chain = url.searchParams.get("chain");
  const address = url.searchParams.get("address");
  const outcome = url.searchParams.get("outcome");
  const hours = Number(url.searchParams.get("hours"));
  if (chain && chain !== "all") query.chain = chain;
  if (address && address !== "all") query.address = address.toLowerCase();
  if (outcome === "landed" || outcome === "reverted") query.outcome = outcome;
  if (Number.isFinite(hours) && hours > 0) query.hours = hours;
  return query;
}

/** The bucket width that keeps a window readable: about 48 bars, never sub-five-minute. */
export function stepFor(hours: number): number {
  return Math.max(300, Math.ceil((hours * 3600) / 48 / 300) * 300);
}

export function createDashboard(config: AppConfig, store: Store, sync: Sync, prices: Prices) {
  const chains = new Map(config.chains.map((chain) => [chain.name, chain]));
  const labels = new Map<string, string>();
  for (const chain of config.chains) {
    for (const entry of chain.watched) labels.set(`${chain.name}:${entry.address}`, entry.label);
  }

  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      const state = [...sync.snapshot().entries()].map(([name, held]) => ({ chain: name, ...held }));
      const healthy = state.every((chain) => chain.syncedAt !== null && chain.error === null);
      const status = healthy ? 200 : 503;
      // Left unauthenticated so a probe can reach it, but the detail — which chains are watched,
      // how much history is held — is only for a caller that could read it off the dashboard.
      // The status code is what a monitor acts on, and that is the same either way.
      if (!authenticated(request, config.user, config.password)) {
        json(response, { ok: healthy }, status);
        return;
      }
      json(response, { ok: healthy, chains: state, store: store.stats() }, status);
      return;
    }

    if (!authorised(request, response, config.user, config.password)) return;

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(page());
      return;
    }

    if (url.pathname === "/api/meta") {
      const stats = store.stats();
      json(response, {
        windowHours: config.windowHours,
        refreshSeconds: config.refreshSeconds,
        stats,
        chains: config.chains.map((chain) => ({
          name: chain.name,
          nativeSymbol: chain.nativeSymbol,
          explorerSite: chain.explorerSite,
          addresses: chain.watched,
          state: sync.snapshot().get(chain.name) ?? null,
        })),
      });
      return;
    }

    if (url.pathname === "/api/trades") {
      try {
        const query = queryFrom(url);
        const { where, params } = clauses(query);
        const hours = query.hours ?? config.windowHours;
        const step = stepFor(hours);

        // Aggregates run over every matching row; only the table is capped.
        const rows = store.query(where, params, MAX_ROWS);
        const summary = store.summary(where, params);
        const chart = store.buckets(where, params, step);
        await loadPrices(config.chains, prices, rows, summary.held, chart.held);

        json(response, {
          totals: totals(summary.counts, summary.held, chains, prices),
          series: series(chart.counts, chart.held, chains, prices, step),
          stepSeconds: step,
          trades: priced(rows, chains, prices, labels),
          truncated: rows.length === MAX_ROWS,
          syncedAt: Math.max(0, ...[...sync.snapshot().values()].map((held) => held.syncedAt ?? 0)) || null,
        });
      } catch (error) {
        log.error("A trades query failed", { error: String(error) });
        json(response, { error: String(error) }, 500);
      }
      return;
    }

    json(response, { error: "not found" }, 404);
  });
}

export function serve(config: AppConfig, store: Store, sync: Sync, prices: Prices) {
  const server = createDashboard(config, store, sync, prices);
  server.listen(config.port, config.host, () => {
    log.info("Dashboard listening", { host: config.host, port: config.port, chains: config.chains.map((c) => c.name) });
    if (!config.password) log.warn("AUTH_PASSWORD is empty, so every route is open");
  });
  return server;
}
