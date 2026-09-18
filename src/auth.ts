import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare the lengths separately: timingSafeEqual throws when they differ.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether the request carries the configured credentials. An empty password matches everything,
 * which is what leaves the dashboard open.
 *
 * Separate from `authorised` because a route can be reachable without credentials and still want
 * to know whether it has them — `/healthz` answers a probe either way, but only says how much
 * history it holds to a caller that could have read that off the dashboard.
 */
export function authenticated(request: IncomingMessage, user: string, password: string): boolean {
  if (!password) return true;
  const header = request.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const at = decoded.indexOf(":");
  return at !== -1 && equal(decoded.slice(0, at), user) && equal(decoded.slice(at + 1), password);
}

/**
 * Basic auth over every route, the page included. An empty password leaves the dashboard open,
 * which is only sane behind something else; it says so at boot rather than failing silently.
 */
export function authorised(request: IncomingMessage, response: ServerResponse, user: string, password: string): boolean {
  if (authenticated(request, user, password)) return true;
  response.writeHead(401, { "www-authenticate": 'Basic realm="pnl-dashboard", charset="UTF-8"' });
  response.end("Unauthorized");
  return false;
}
