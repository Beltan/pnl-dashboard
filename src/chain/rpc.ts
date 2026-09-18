import { log } from "../log.ts";

interface RpcCall {
  method: string;
  params: unknown[];
}

interface RpcAnswer<T> {
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

/** Batched JSON-RPC. Answers come back keyed by request order, which the node may not preserve. */
export async function rpcBatch<T>(url: string, calls: RpcCall[], chunk = 40): Promise<(T | null)[]> {
  const out: (T | null)[] = new Array(calls.length).fill(null);
  for (let start = 0; start < calls.length; start += chunk) {
    const slice = calls.slice(start, start + chunk);
    const body = slice.map((call, at) => ({ jsonrpc: "2.0", id: at, method: call.method, params: call.params }));
    let answers: RpcAnswer<T>[];
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      answers = (await response.json()) as RpcAnswer<T>[];
    } catch (error) {
      log.warn("An RPC batch failed", { url, error: String(error) });
      continue;
    }
    for (const answer of Array.isArray(answers) ? answers : []) {
      if (answer.error) {
        log.warn("An RPC call answered an error", { method: slice[answer.id]?.method, error: answer.error.message });
        continue;
      }
      if (answer.result !== undefined && answer.id >= 0 && answer.id < slice.length) {
        out[start + answer.id] = answer.result;
      }
    }
  }
  return out;
}

export interface Receipt {
  transactionHash: string;
  blockNumber: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  from: string;
  to: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

export async function receipts(url: string, hashes: string[]): Promise<Map<string, Receipt>> {
  const answers = await rpcBatch<Receipt>(url, hashes.map((hash) => ({ method: "eth_getTransactionReceipt", params: [hash] })));
  const found = new Map<string, Receipt>();
  for (const receipt of answers) {
    if (receipt?.transactionHash) found.set(receipt.transactionHash.toLowerCase(), receipt);
  }
  return found;
}
