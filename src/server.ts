import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authenticated, authorised } from "./auth.ts";
import { bounded, clauses, loadPrices, priced, series, totals, withinBounds, type Bounds, type Query } from "./api.ts";
import { log } from "./log.ts";
import { page } from "./page.ts";
import type { Prices } from "./pricing.ts";
import type { Store } from "./store.ts";
import type { Sync } from "./sync.ts";
import type { AppConfig } from "./types.ts";

/** What the rows-per-page selector offers. Anything else is rounded to the default. */
const PAGE_SIZES = [25, 50, 100, 250];
const DEFAULT_PAGE_SIZE = 50;

/**
 * How many rows a net-USD bound may value before giving up on being exact.
 *
 * SQL can page and count the other filters itself. A net bound cannot: every candidate has to be
 * priced before it is known whether it matches, so the work is the size of the match, not of the
 * page. This bounds that work; the answer says when it was reached.
 */
const MAX_SCAN = 50_000;

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

/** An empty box is no bound at all; zero is a real one, so blank and 0 cannot be conflated. */
function boundsFrom(url: URL): Bounds {
  const bounds: Bounds = {};
  for (const [key, name] of [["min", "minNet"], ["max", "maxNet"]] as const) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) bounds[key] = value;
  }
  return bounds;
}

export function pageSizeFrom(url: URL): number {
  const size = Number(url.searchParams.get("size"));
  return PAGE_SIZES.includes(size) ? size : DEFAULT_PAGE_SIZE;
}

/** Pages are one-based and clamped: a filter that shrinks the result must not strand the reader. */
export function pageFrom(asked: number, total: number, size: number): number {
  const pages = Math.max(1, Math.ceil(total / size));
  if (!Number.isFinite(asked) || asked < 1) return 1;
  return Math.min(Math.floor(asked), pages);
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
        const bounds = boundsFrom(url);
        const { where, params } = clauses(query);
        const hours = query.hours ?? config.windowHours;
        const step = stepFor(hours);
        const size = pageSizeFrom(url);
        const asked = Number(url.searchParams.get("page") ?? 1);

        // Aggregates run over every matching row, so the tiles and the chart describe the window
        // rather than the page being looked at. A net bound narrows the table alone, for the same
        // reason it cannot be a WHERE clause: the totals would have to price the window twice.
        const summary = store.summary(where, params);
        const chart = store.buckets(where, params, step);

        let page: number;
        let total: number;
        let rows: ReturnType<typeof store.query>;
        let scanLimited = false;

        if (bounded(bounds)) {
          // Valued first, then filtered, then paged, because none of that can happen in SQL.
          const scan = store.query(where, params, MAX_SCAN, 0);
          scanLimited = scan.length === MAX_SCAN;
          await loadPrices(config.chains, prices, scan, summary.held, chart.held);
          const matching = withinBounds(priced(scan, chains, prices, labels), bounds);
          total = matching.length;
          page = pageFrom(asked, total, size);
          json(response, {
            totals: totals(summary.counts, summary.held, chains, prices),
            series: series(chart.counts, chart.held, chains, prices, step),
            stepSeconds: step,
            trades: matching.slice((page - 1) * size, page * size),
            page, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)), scanLimited,
            syncedAt: Math.max(0, ...[...sync.snapshot().values()].map((held) => held.syncedAt ?? 0)) || null,
          });
          return;
        }

        total = store.count(where, params);
        page = pageFrom(asked, total, size);
        rows = store.query(where, params, size, (page - 1) * size);
        await loadPrices(config.chains, prices, rows, summary.held, chart.held);

        json(response, {
          totals: totals(summary.counts, summary.held, chains, prices),
          series: series(chart.counts, chart.held, chains, prices, step),
          stepSeconds: step,
          trades: priced(rows, chains, prices, labels),
          page, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)), scanLimited,
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
