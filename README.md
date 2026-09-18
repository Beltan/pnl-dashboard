# pnl-dashboard

A profit-and-loss dashboard for arbitrary chains and addresses, configured entirely by environment.

It reads the chain, not a bot's database. For every transaction a watched address sent, it takes the
receipt, nets the ERC20 transfers that ended with a watched address, prices what was left behind, and
subtracts the gas actually paid. That makes it independent of whatever produced the transactions, and
it makes the chain the record: a bot that fails to write a row, or writes the wrong one, cannot skew
what this shows.

## What it needs

Per chain: a JSON-RPC endpoint, an Etherscan-compatible explorer API (Blockscout serves the same
shape), and the addresses to watch. Prices come from GeckoTerminal. Nothing is written anywhere.

## Configuration

Every chain named in `CHAINS` reads its own block of variables, prefixed with its upper-cased name,
so adding a chain is configuration and never code. Copy `.env.example` to `.env` and edit it.

| Variable | Meaning |
|---|---|
| `CHAINS` | comma-separated chain names, e.g. `flare,avax` |
| `<CHAIN>_RPC_URL` | JSON-RPC endpoint, used for receipts and token metadata |
| `<CHAIN>_EXPLORER_URL` | Etherscan-compatible API root, used to list an address's transactions |
| `<CHAIN>_EXPLORER_SITE` | where a transaction link points; defaults to the API root without `/api` |
| `<CHAIN>_ADDRESSES` | `address[:label]`, comma separated |
| `<CHAIN>_NATIVE_SYMBOL` | gas token symbol, for display |
| `<CHAIN>_NATIVE_DECIMALS` | defaults to 18 |
| `<CHAIN>_GECKO_NETWORK` | GeckoTerminal network id; empty leaves everything unpriced |
| `<CHAIN>_NATIVE_PRICE_TOKEN` | the wrapped native token, which is how gas gets a USD price |
| `WINDOW_HOURS` | how much history to hold in memory (default 24) |
| `REFRESH_SECONDS` | how often to re-read the chains (default 60) |
| `AUTH_USER` / `AUTH_PASSWORD` | basic auth over every route; an empty password leaves it open |
| `PORT` / `HOST` | where to listen |

## Running

```bash
npm install
npm test          # unit tests, no network
npm run build
npm start         # reads .env if present
```

Or `docker compose up -d --build`, which reads the same `.env`.

## Routes

| Route | What it serves |
|---|---|
| `/` | the dashboard; `?theme=dark\|light\|auto` overrides the stored theme |
| `/api/meta` | configured chains, addresses and the window held |
| `/api/trades` | filtered trades, totals and the chart series; `chain`, `address`, `outcome`, `hours` |
| `/healthz` | per-chain refresh state; 503 until every chain has refreshed once |

## How profit is decided

A transaction's profit is the largest positive net ERC20 delta across the watched addresses. In a
flash-swap round trip every token it passes through nets to zero and the surplus rests in one, so
that delta is the trade's gross. Gas is `gasUsed x effectiveGasPrice` in native units, priced through
the wrapped native token. A token GeckoTerminal does not price is reported as unpriced rather than
valued at zero, and the totals say how many rows that left out: a missing price is not no profit.

## What it does not do

It holds its window in memory and backfills on boot, so a restart costs one explorer pass and nothing
else. It tracks no positions, sends nothing, and has no database. Whatever the transactions were for
— arbitrage, liquidations, anything else — it only knows what the chain says they earned and cost.
