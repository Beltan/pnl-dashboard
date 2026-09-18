import type { AppConfig, ChainConfig, Watched } from "./types.ts";

/** `0xabc…` or `0xabc…:Some label`, comma separated. */
export function parseWatched(raw: string): Watched[] {
  const seen = new Set<string>();
  const watched: Watched[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    const address = (at === -1 ? trimmed : trimmed.slice(0, at)).trim().toLowerCase();
    const label = at === -1 ? "" : trimmed.slice(at + 1).trim();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw new Error(`"${trimmed}" is not an address; expected 0x + 40 hex digits`);
    }
    if (seen.has(address)) continue;
    seen.add(address);
    watched.push({ address, label: label || short(address) });
  }
  return watched;
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

function number(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key}=${raw} must be a positive number`);
  return value;
}

/** Chains name their own variables, so a new chain is configuration and never code. */
function chainFrom(env: NodeJS.ProcessEnv, name: string): ChainConfig {
  const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const explorerUrl = required(env, `${prefix}_EXPLORER_URL`).replace(/\/+$/, "");
  let watched: Watched[];
  try {
    watched = parseWatched(required(env, `${prefix}_ADDRESSES`));
  } catch (error) {
    throw new Error(`${prefix}_ADDRESSES: ${(error as Error).message}`);
  }
  if (watched.length === 0) throw new Error(`${prefix}_ADDRESSES lists no address`);
  return {
    name: name.toLowerCase(),
    explorerUrl,
    explorerSite: (env[`${prefix}_EXPLORER_SITE`]?.trim() ?? explorerUrl.replace(/\/api$/, "")).replace(/\/+$/, ""),
    nativeSymbol: env[`${prefix}_NATIVE_SYMBOL`]?.trim() || "NATIVE",
    nativeDecimals: number(env, `${prefix}_NATIVE_DECIMALS`, 18),
    geckoNetwork: env[`${prefix}_GECKO_NETWORK`]?.trim() ?? "",
    nativePriceToken: (env[`${prefix}_NATIVE_PRICE_TOKEN`]?.trim() ?? "").toLowerCase(),
    watched,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const names = required(env, "CHAINS")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error("CHAINS lists no chain");

  const chains = names.map((name) => chainFrom(env, name));
  const duplicate = chains.map((chain) => chain.name).find((name, at, all) => all.indexOf(name) !== at);
  if (duplicate) throw new Error(`CHAINS lists ${duplicate} twice`);

  return {
    port: number(env, "PORT", 8080),
    host: env.HOST?.trim() || "0.0.0.0",
    user: env.AUTH_USER?.trim() || "admin",
    // Empty leaves the dashboard open, which is a choice the operator has to make explicitly.
    password: env.AUTH_PASSWORD ?? "",
    windowHours: number(env, "WINDOW_HOURS", 24),
    refreshSeconds: number(env, "REFRESH_SECONDS", 60),
    dbPath: env.DB_PATH?.trim() || "data/pnl.db",
    chains,
  };
}
