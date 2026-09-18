import { log } from "./log.ts";

interface Cached {
  usd: number;
  at: number;
}

const TTL_MS = 5 * 60 * 1000;
/** GeckoTerminal takes up to 30 addresses per call and rate-limits the endpoint. */
const BATCH = 30;

/**
 * Token prices in USD, per GeckoTerminal network. Cached, because a refresh prices the same handful
 * of tokens every time and the endpoint is rate-limited.
 *
 * A token it does not know stays unpriced rather than being valued at zero: a missing price is not
 * the same as no profit, and the totals say how many rows it left out.
 */
export class Prices {
  private readonly cache = new Map<string, Cached>();
  private readonly decimals = new Map<string, number>();

  async load(network: string, tokens: string[]): Promise<void> {
    if (!network) return;
    const now = Date.now();
    const stale = [...new Set(tokens.map((token) => token.toLowerCase()))].filter((token) => {
      const hit = this.cache.get(this.key(network, token));
      return !hit || now - hit.at > TTL_MS;
    });

    for (let start = 0; start < stale.length; start += BATCH) {
      const slice = stale.slice(start, start + BATCH);
      const url = `https://api.geckoterminal.com/api/v2/simple/networks/${network}/token_price/${slice.join(",")}`;
      try {
        const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { data?: { attributes?: { token_prices?: Record<string, string> } } };
        const prices = body.data?.attributes?.token_prices ?? {};
        for (const [token, raw] of Object.entries(prices)) {
          const usd = Number(raw);
          if (Number.isFinite(usd) && usd > 0) this.cache.set(this.key(network, token.toLowerCase()), { usd, at: Date.now() });
        }
      } catch (error) {
        log.warn("A price batch failed", { network, tokens: slice.length, error: String(error) });
      }
    }
  }

  usd(network: string, token: string): number | null {
    return this.cache.get(this.key(network, token.toLowerCase()))?.usd ?? null;
  }

  /** Decimals are read once per token from the chain and never change. */
  rememberDecimals(token: string, value: number): void {
    this.decimals.set(token.toLowerCase(), value);
  }

  decimalsOf(token: string): number | undefined {
    return this.decimals.get(token.toLowerCase());
  }

  private key(network: string, token: string): string {
    return `${network}:${token}`;
  }
}
