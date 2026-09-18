import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authorised } from "./auth.ts";
import { filter, series, totals, type Query } from "./api.ts";
import { log } from "./log.ts";
import { page } from "./page.ts";
import type { Poller } from "./poller.ts";
import type { AppConfig } from "./types.ts";

function json(response: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(text);
}

function queryFrom(url: URL): Query {
  const hours = Number(url.searchParams.get("hours"));
  const outcome = url.searchParams.get("outcome");
  const query: Query = {};
  const chain = url.searchParams.get("chain");
  const address = url.searchParams.get("address");
  if (chain && chain !== "all") query.chain = chain;
  if (address && address !== "all") query.address = address.toLowerCase();
  if (outcome === "landed" || outcome === "reverted") query.outcome = outcome;
  if (Number.isFinite(hours) && hours > 0) query.hours = hours;
  return query;
}

/** The bucket width that keeps a window readable: about 24-60 bars, never sub-minute. */
export function stepFor(hours: number): number {
  const target = Math.ceil((hours * 3600) / 48 / 300) * 300;
  return Math.max(300, target);
}

export function createDashboard(config: AppConfig, poller: Poller) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      const chains = [...poller.snapshot().entries()].map(([name, state]) => ({
        chain: name,
        trades: state.trades.length,
        refreshedAt: state.refreshedAt,
        error: state.error,
      }));
      const healthy = chains.every((chain) => chain.refreshedAt !== null && chain.error === null);
      json(response, { ok: healthy, chains }, healthy ? 200 : 503);
      return;
    }

    if (!authorised(request, response, config.user, config.password)) return;

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(page());
      return;
    }

    if (url.pathname === "/api/meta") {
      json(response, {
        windowHours: config.windowHours,
        refreshSeconds: config.refreshSeconds,
        chains: config.chains.map((chain) => ({
          name: chain.name,
          nativeSymbol: chain.nativeSymbol,
          explorerSite: chain.explorerSite,
          addresses: chain.watched,
        })),
      });
      return;
    }

    if (url.pathname === "/api/trades") {
      const query = queryFrom(url);
      const rows = filter(poller.trades(), query);
      const hours = query.hours ?? config.windowHours;
      json(response, {
        totals: totals(rows),
        series: series(rows, stepFor(hours)),
        stepSeconds: stepFor(hours),
        trades: rows.slice(0, 1000),
        truncated: Math.max(0, rows.length - 1000),
        refreshedAt: Math.max(0, ...[...poller.snapshot().values()].map((state) => state.refreshedAt ?? 0)) || null,
      });
      return;
    }

    json(response, { error: "not found" }, 404);
  });
}

export function serve(config: AppConfig, poller: Poller) {
  const server = createDashboard(config, poller);
  server.listen(config.port, config.host, () => {
    log.info("Dashboard listening", { host: config.host, port: config.port, chains: config.chains.map((c) => c.name) });
    if (!config.password) log.warn("AUTH_PASSWORD is empty, so every route is open");
  });
  return server;
}
