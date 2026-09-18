import { DatabaseSync } from "node:sqlite";
import { log } from "./log.ts";

/**
 * History lives on disk, so a backfill from a contract's first transaction happens once and a
 * restart costs nothing.
 *
 * Amounts are kept raw and valued at query time from current prices, which is how the number is
 * actually read: what the profit being held is worth now. Transfers are stored one row per
 * movement rather than pre-netted, so the same movement seen from two watched addresses collapses
 * on the primary key instead of being counted twice.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        chain      TEXT NOT NULL,
        hash       TEXT NOT NULL,
        from_addr  TEXT NOT NULL,
        to_addr    TEXT,
        block      INTEGER NOT NULL,
        ts         INTEGER NOT NULL,
        status     INTEGER NOT NULL,
        gas_used   INTEGER NOT NULL,
        gas_native REAL NOT NULL,
        gas_ours   INTEGER NOT NULL,
        PRIMARY KEY (chain, hash)
      );
      CREATE INDEX IF NOT EXISTS trades_ts ON trades (chain, ts);

      -- delta is signed in raw units: what this movement added to, or took from, the watched set.
      -- It is a double, so it carries magnitude exactly and precision far past anything a USD
      -- figure can show.
      CREATE TABLE IF NOT EXISTS transfers (
        chain     TEXT NOT NULL,
        hash      TEXT NOT NULL,
        token     TEXT NOT NULL,
        symbol    TEXT NOT NULL,
        decimals  INTEGER NOT NULL,
        from_addr TEXT NOT NULL,
        to_addr   TEXT NOT NULL,
        value     TEXT NOT NULL,
        delta     REAL NOT NULL,
        PRIMARY KEY (chain, hash, token, from_addr, to_addr, value)
      );
      CREATE INDEX IF NOT EXISTS transfers_hash ON transfers (chain, hash);

      CREATE TABLE IF NOT EXISTS cursors (
        chain   TEXT NOT NULL,
        address TEXT NOT NULL,
        action  TEXT NOT NULL,
        block   INTEGER NOT NULL,
        PRIMARY KEY (chain, address, action)
      );
    `);
  }

  cursor(chain: string, address: string, action: string): number {
    const row = this.db
      .prepare("SELECT block FROM cursors WHERE chain = ? AND address = ? AND action = ?")
      .get(chain, address, action) as { block?: number } | undefined;
    return row?.block ?? 0;
  }

  setCursor(chain: string, address: string, action: string, block: number): void {
    this.db
      .prepare(
        "INSERT INTO cursors (chain, address, action, block) VALUES (?,?,?,?) " +
          "ON CONFLICT(chain, address, action) DO UPDATE SET block = excluded.block",
      )
      .run(chain, address, action, block);
  }

  putTrades(rows: TradeRecord[]): number {
    if (rows.length === 0) return 0;
    const insert = this.db.prepare(
      "INSERT INTO trades (chain, hash, from_addr, to_addr, block, ts, status, gas_used, gas_native, gas_ours) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain, hash) DO UPDATE SET " +
        "status = excluded.status, gas_used = excluded.gas_used, gas_native = excluded.gas_native, gas_ours = excluded.gas_ours",
    );
    return this.write(() => {
      for (const row of rows) {
        insert.run(row.chain, row.hash, row.from, row.to, row.block, row.ts, row.status, row.gasUsed, row.gasNative, row.gasOurs ? 1 : 0);
      }
      return rows.length;
    });
  }

  putTransfers(rows: TransferRecord[]): number {
    if (rows.length === 0) return 0;
    const insert = this.db.prepare(
      "INSERT INTO transfers (chain, hash, token, symbol, decimals, from_addr, to_addr, value, delta) " +
        "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(chain, hash, token, from_addr, to_addr, value) DO NOTHING",
    );
    return this.write(() => {
      for (const row of rows) {
        insert.run(row.chain, row.hash, row.token, row.symbol, row.decimals, row.from, row.to, row.value, row.delta);
      }
      return rows.length;
    });
  }

  /**
   * Trades, each with the one token it was left holding: the token whose net is largest and
   * positive. A round trip nets every token it passed through to zero and leaves the surplus in one.
   */
  query(where: string, params: unknown[], limit: number): QueryRow[] {
    return this.db
      .prepare(
        `WITH nets AS (
           SELECT chain, hash, token, MAX(symbol) symbol, MAX(decimals) decimals, SUM(delta) net
             FROM transfers GROUP BY chain, hash, token
         ), best AS (
           SELECT chain, hash, token, symbol, decimals, net,
                  ROW_NUMBER() OVER (PARTITION BY chain, hash ORDER BY net DESC) rank
             FROM nets WHERE net > 0
         )
         SELECT t.chain, t.hash, t.from_addr, t.to_addr, t.block, t.ts, t.status,
                t.gas_used, t.gas_native, t.gas_ours,
                b.token, b.symbol, b.decimals, b.net
           FROM trades t
           LEFT JOIN best b ON b.chain = t.chain AND b.hash = t.hash AND b.rank = 1
          WHERE ${where}
          ORDER BY t.ts DESC
          LIMIT ?`,
      )
      .all(...(params as never[]), limit) as unknown as QueryRow[];
  }

  stats(): { trades: number; transfers: number; oldest: number | null; newest: number | null } {
    const trades = this.db.prepare("SELECT COUNT(*) n, MIN(ts) o, MAX(ts) w FROM trades").get() as {
      n: number;
      o: number | null;
      w: number | null;
    };
    const transfers = this.db.prepare("SELECT COUNT(*) n FROM transfers").get() as { n: number };
    return { trades: trades.n, transfers: transfers.n, oldest: trades.o, newest: trades.w };
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      log.warn("Closing the store failed", { error: String(error) });
    }
  }

  private write<T>(body: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = body();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export interface TradeRecord {
  chain: string;
  hash: string;
  from: string;
  to: string | null;
  block: number;
  ts: number;
  status: number;
  gasUsed: number;
  gasNative: number;
  /** Whether a watched address paid this gas. A call to our contract from elsewhere costs us nothing. */
  gasOurs: boolean;
}

export interface TransferRecord {
  chain: string;
  hash: string;
  token: string;
  symbol: string;
  decimals: number;
  from: string;
  to: string;
  value: string;
  delta: number;
}

export interface QueryRow {
  chain: string;
  hash: string;
  from_addr: string;
  to_addr: string | null;
  block: number;
  ts: number;
  status: number;
  gas_used: number;
  gas_native: number;
  gas_ours: number;
  token: string | null;
  symbol: string | null;
  decimals: number | null;
  net: number | null;
}
