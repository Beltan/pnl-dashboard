import type { Receipt } from "./rpc.ts";

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface Kept {
  token: string;
  raw: bigint;
}

function addressOf(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * What the transaction left behind with any of `holders`: the net ERC20 delta, summed per token
 * over every Transfer in the receipt. A round trip nets every token it passed through to zero and
 * leaves the surplus in one, so the token with the largest positive delta is the profit.
 *
 * `null` when nothing was left behind, which is every reverted transaction and any that only spent.
 */
export function keptBy(receipt: Receipt, holders: Set<string>): Kept | null {
  const net = new Map<string, bigint>();
  for (const entry of receipt.logs ?? []) {
    const [topic0, fromTopic, toTopic] = entry.topics ?? [];
    if (topic0?.toLowerCase() !== TRANSFER || !fromTopic || !toTopic) continue;
    let value: bigint;
    try {
      value = entry.data && entry.data !== "0x" ? BigInt(entry.data) : 0n;
    } catch {
      continue;
    }
    const token = entry.address.toLowerCase();
    if (holders.has(addressOf(toTopic))) net.set(token, (net.get(token) ?? 0n) + value);
    if (holders.has(addressOf(fromTopic))) net.set(token, (net.get(token) ?? 0n) - value);
  }

  let best: Kept | null = null;
  for (const [token, raw] of net) {
    if (raw > 0n && (best === null || raw > best.raw)) best = { token, raw };
  }
  return best;
}

/** Raw units to whole tokens. Returns a float, for display and USD only - never for arithmetic on chain values. */
export function toWhole(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = Number(raw / scale);
  const part = Number(raw % scale) / Number(scale);
  return whole + part;
}

export function gasNative(gasUsed: bigint, effectiveGasPrice: bigint, decimals: number): number {
  return toWhole(gasUsed * effectiveGasPrice, decimals);
}
