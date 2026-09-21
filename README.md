# pnl-dashboard

A profit-and-loss dashboard for arbitrary chains and addresses, configured entirely by environment.

It reads the chain, not a bot's database. For every transaction involving a watched address it takes
the gas actually paid and nets the ERC20 movements that ended with the watched set, then prices what
was left behind. That makes it independent of whatever produced the transactions, and it makes the
chain the record: a bot that fails to write a row, or writes the wrong one, cannot skew what this
shows.

## Where the data comes from

Two Etherscan-compatible explorer endpoints per chain, and nothing else:

- `txlist` — the transactions, with gas used, the effective gas price, and whether they landed.
- `tokentx` — the ERC20 movements, carrying each token's own symbol and decimals.

No archive node, no `eth_getTransactionReceipt` per transaction, no ABI. A wallet with a hundred
thousand transactions backfills in explorer pages rather than in a hundred thousand RPC calls.
Prices come from GeckoTerminal.

## History and backfill

History is kept in full, in SQLite, from each watched address's **first** transaction. The first run
backfills; every run after that resumes from a per-address, per-endpoint block cursor, so a restart
costs one page. `WINDOW_HOURS` is only what the page opens on — the window selector reaches back to
all of it.

The walk advances by block rather than page number, because these APIs cap how deep `page=` goes and
the cap sits well inside a busy wallet's history. The boundary block is re-read on the next pass and
collapses on the primary key, so a block whose rows span two pages is never half-read.

An explorer page that fails stops that address's walk without discarding the blocks already read, so
the next pass resumes rather than starting over. The pass is still reported as incomplete: the chain
carries the reason, `syncedAt` stays at the last pass that read everything, and `/healthz` answers
503. A chain whose explorer never answers reads as unhealthy rather than as one with nothing new.

## Configuration

Every chain named in `CHAINS` reads its own block of variables, prefixed with its upper-cased name,
so adding a chain is configuration and never code. Copy `.env.example` to `.env` and edit it.

| Variable | Meaning |
|---|---|
| `CHAINS` | comma-separated chain names, e.g. `flare,avax` |
| `<CHAIN>_EXPLORER_URL` | Etherscan-compatible API root; Blockscout and Routescan both serve it |
| `<CHAIN>_EXPLORER_SITE` | where a transaction link points; defaults to the API root without `/api` |
| `<CHAIN>_ADDRESSES` | `address[:label]`, comma separated — contracts and the wallets that drive them |
| `<CHAIN>_NATIVE_SYMBOL` / `_NATIVE_DECIMALS` | the gas token |
| `<CHAIN>_GECKO_NETWORK` | GeckoTerminal network id; empty leaves everything unpriced |
| `<CHAIN>_NATIVE_PRICE_TOKEN` | the wrapped native token, which is how gas gets a USD price |
| `WINDOW_HOURS` | what the page opens on (default 24); history is kept in full regardless |
| `REFRESH_SECONDS` | how often to sync (default 60); passes never overlap |
| `CONFIRM_BLOCKS` | how far behind its high-water mark each cursor is parked (default 600), so blocks an explorer indexed out of order are read again |
| `DB_PATH` | where the history lives (default `data/pnl.db`) |
| `AUTH_USER` / `AUTH_PASSWORD` | basic auth over every route; an empty password leaves it open |
| `PORT` / `HOST` | where to listen |

Watch both a contract and the wallet that drives it. The contract is where profit rests; the wallet
is what pays the gas, and gas is only counted when a watched address paid it — a call to one of our
contracts from someone else's wallet earns us the profit without costing us the fee.

## Running

```bash
npm install
npm test          # unit tests, no network
npm run build
npm start         # reads .env if present
```

Or `docker compose up -d --build`, which reads the same `.env`. SQLite needs Node's
`--experimental-sqlite` flag, which the scripts and the image already pass.

The history lives in the `history` volume, mounted at `/app/data`, so a rebuild keeps it. Set
`DB_PATH` somewhere under that directory or the database goes into the container's own layer and
every deploy backfills from the beginning again.

## Routes

| Route | What it serves |
|---|---|
| `/` | the dashboard; `?theme=dark\|light\|auto` overrides the stored theme |
| `/api/meta` | configured chains, addresses, sync state and how much history is held |
| `/api/trades` | one page of trades, plus totals and the chart series over the whole window; `chain`, `address`, `outcome`, `hours` (`hours=0` is all of it), `minNet`/`maxNet`, `page`, `size` |
| `/healthz` | `503` until every chain has read its full history, and whenever a pass since then stopped short; per-chain state and store counts are added for an authenticated caller |

## Paging and the net filter

The table is paged; the tiles and the chart are not. Both always describe the whole window, so
turning to page 40 does not change what the window earned.

A page is chosen before the transfers are netted, so its cost is the size of the page rather than
the size of the history: fifty rows out of a hundred and sixty thousand is about the same work as
the first fifty.

`minNet` and `maxNet` are the exception, and the reason is worth knowing. Net is priced when the
request is answered, from prices held in memory, and is never stored — so SQL cannot filter on it
and cannot count it either. Those two bounds are applied after the rows are valued, which means the
rows have to be valued first. That work is capped at the 50,000 most recent matching transactions;
the page says so when the cap is reached. A trade holding a token with no price has no net to
compare, so a bound leaves it out rather than guessing which side of the line it falls.

## How profit is decided

A transaction's profit is the largest positive net across the watched set, per token. In a
flash-swap round trip every token it passes through nets to zero and the surplus rests in one, so
that net is the trade's gross. Movements between two watched addresses are dropped: moving your own
money is not profit, which is also why a sweep from a contract to its owner does not register as one.

Gas is `gasUsed x gasPrice` in native units, priced through the wrapped native token.

A reverted transaction moved no token and still paid its gas, so its net is that gas as a loss. The
same is true of a transaction that landed and kept nothing. That is a real zero rather than a
missing value, and it is not the same as a trade holding a token GeckoTerminal cannot price, whose
profit stays unknown.

**Amounts are valued at current prices, not the price at the time of the trade.** That is deliberate
— it answers "what is the profit I am holding worth now" — but it means a historical window is
revalued every time you load it, and a token that has moved a long way since will not reconcile with
what it was worth on the day. A token GeckoTerminal does not price is reported as unpriced rather
than valued at zero, and the totals say how many rows that left out.

## What it does not do

It tracks no positions, sends nothing, and knows nothing about lanes, triggers or strategies —
whatever the transactions were for, it only knows what the chain says they earned and cost. It has
no notion of a trade that was planned and refused, because such a thing never reaches the chain.
