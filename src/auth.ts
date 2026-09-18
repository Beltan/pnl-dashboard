import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare the lengths separately: timingSafeEqual throws when they differ.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Basic auth over every route, the page included. An empty password leaves the dashboard open,
 * which is only sane behind something else; it says so at boot rather than failing silently.
 */
export function authorised(request: IncomingMessage, response: ServerResponse, user: string, password: string): boolean {
  if (!password) return true;
  const header = request.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const at = decoded.indexOf(":");
    if (at !== -1 && equal(decoded.slice(0, at), user) && equal(decoded.slice(at + 1), password)) return true;
  }
  response.writeHead(401, { "www-authenticate": 'Basic realm="pnl-dashboard", charset="UTF-8"' });
  response.end("Unauthorized");
  return false;
}
