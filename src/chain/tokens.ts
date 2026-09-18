import { rpcBatch } from "./rpc.ts";

/** `decimals()` and `symbol()`. */
const DECIMALS = "0x313ce567";
const SYMBOL = "0x95d89b41";

function decodeUint(hex: string | null): number | null {
  if (!hex || hex === "0x") return null;
  const value = Number(BigInt(hex));
  return Number.isFinite(value) ? value : null;
}

/** ABI-decodes a dynamic string return; falls back to a bytes32-style symbol. */
function decodeString(hex: string | null): string | null {
  if (!hex || hex === "0x") return null;
  const body = hex.slice(2);
  if (body.length >= 128) {
    const length = Number(BigInt(`0x${body.slice(64, 128)}`));
    if (length > 0 && length <= 64) {
      const text = Buffer.from(body.slice(128, 128 + length * 2), "hex").toString("utf8");
      if (text.trim()) return text.trim();
    }
  }
  const raw = Buffer.from(body.slice(0, 64), "hex").toString("utf8").replace(/\0+$/, "").trim();
  return raw || null;
}

export interface TokenMeta {
  decimals: number;
  symbol: string;
}

/** Read once per token and cached by the caller: neither value changes. */
export async function tokenMeta(rpcUrl: string, tokens: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  if (tokens.length === 0) return out;
  const calls = tokens.flatMap((token) => [
    { method: "eth_call", params: [{ to: token, data: DECIMALS }, "latest"] },
    { method: "eth_call", params: [{ to: token, data: SYMBOL }, "latest"] },
  ]);
  const answers = await rpcBatch<string>(rpcUrl, calls);
  tokens.forEach((token, at) => {
    const decimals = decodeUint(answers[at * 2] ?? null);
    const symbol = decodeString(answers[at * 2 + 1] ?? null);
    if (decimals !== null) out.set(token.toLowerCase(), { decimals, symbol: symbol ?? `${token.slice(0, 6)}…` });
  });
  return out;
}
