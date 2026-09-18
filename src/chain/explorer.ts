import { log } from "../log.ts";

/** What an Etherscan-compatible `txlist` row carries that we use. */
export interface ExplorerTx {
  hash: string;
  from: string;
  to: string;
  blockNumber: string;
  timeStamp: string;
  isError: string;
  txreceipt_status: string;
  gasUsed: string;
  gasPrice: string;
}

/** Blockscout answers 403 to the default fetch agent. */
const HEADERS = { "user-agent": "pnl-dashboard", accept: "application/json" };
const PAGE = 1_000;
const MAX_PAGES = 20;

/**
 * Every transaction the address sent since `sinceSeconds`, newest first. Paged until the explorer
 * runs past the window, so a busy address is not truncated to one page.
 */
export async function sentSince(explorerUrl: string, address: string, sinceSeconds: number): Promise<ExplorerTx[]> {
  const kept: ExplorerTx[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${explorerUrl}?module=account&action=txlist&address=${address}&sort=desc&page=${page}&offset=${PAGE}`;
    let rows: ExplorerTx[];
    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { result?: unknown };
      rows = Array.isArray(body.result) ? (body.result as ExplorerTx[]) : [];
    } catch (error) {
      log.warn("An explorer page failed", { address, page, error: String(error) });
      break;
    }
    if (rows.length === 0) break;

    // Only what this address sent: the same list carries transactions sent to it.
    for (const row of rows) {
      if (Number(row.timeStamp) < sinceSeconds) continue;
      if (row.from?.toLowerCase() === address) kept.push(row);
    }
    const oldest = rows[rows.length - 1];
    if (!oldest || Number(oldest.timeStamp) < sinceSeconds || rows.length < PAGE) break;
  }
  return kept;
}
