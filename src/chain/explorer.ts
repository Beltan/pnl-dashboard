import { log } from "../log.ts";

/** A transaction row from `txlist`. `gasPrice` is the effective price actually paid. */
export interface TxRow {
  hash: string;
  from: string;
  to: string;
  blockNumber: string;
  timeStamp: string;
  txreceipt_status: string;
  isError: string;
  gasUsed: string;
  gasPrice: string;
}

/** An ERC20 movement from `tokentx`, which carries the token's own symbol and decimals. */
export interface TokenRow {
  hash: string;
  from: string;
  to: string;
  blockNumber: string;
  timeStamp: string;
  contractAddress: string;
  value: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

/** Blockscout answers 403 to the default fetch agent. */
const HEADERS = { "user-agent": "pnl-dashboard", accept: "application/json" };
/** The largest page these APIs serve. Deep `page=` paging is capped, so the block cursor walks instead. */
const PAGE = 10_000;
/** A stop, so a malformed answer cannot spin forever. */
const MAX_PAGES = 400;

async function page<T>(explorerUrl: string, action: string, address: string, startBlock: number): Promise<T[]> {
  const url =
    `${explorerUrl}?module=account&action=${action}&address=${address}` +
    `&sort=asc&startblock=${startBlock}&endblock=99999999&page=1&offset=${PAGE}`;
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { status?: string; message?: string; result?: unknown };
  if (!Array.isArray(body.result)) {
    // "No transactions found" is an empty history, not a failure.
    if (body.message && /no transactions|no token transfers/i.test(body.message)) return [];
    throw new Error(body.message ?? "explorer returned no result array");
  }
  return body.result as T[];
}

/**
 * Every row from `startBlock` forward, oldest first, walked by block rather than by page number:
 * these APIs cap how deep `page=` goes, and the cap is well inside a wallet's history.
 *
 * Rows in the boundary block are re-read on the next pass and deduplicated by the caller, which is
 * what keeps a block with more rows than one page from being split.
 */
export async function walk<T extends { blockNumber: string; hash: string }>(
  explorerUrl: string,
  action: "txlist" | "tokentx",
  address: string,
  startBlock: number,
  onPage: (rows: T[]) => void,
): Promise<number> {
  let cursor = startBlock;
  let highest = startBlock;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    let rows: T[];
    try {
      rows = await page<T>(explorerUrl, action, address, cursor);
    } catch (error) {
      log.warn("An explorer page failed", { address, action, cursor, error: String(error) });
      break;
    }
    if (rows.length === 0) break;
    onPage(rows);
    const last = rows[rows.length - 1]!;
    highest = Math.max(highest, Number(last.blockNumber));
    if (rows.length < PAGE) break;
    // Re-read the boundary block so a block split across pages is not lost.
    const next = Number(last.blockNumber);
    cursor = next > cursor ? next : cursor + 1;
  }
  return highest;
}
