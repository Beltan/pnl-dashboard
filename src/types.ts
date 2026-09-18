/** One address the dashboard follows on one chain. */
export interface Watched {
  address: string;
  label: string;
}

export interface ChainConfig {
  /** Key used in env var names and in the API, lowercased. */
  name: string;
  rpcUrl: string;
  /** Etherscan-compatible API root; Blockscout serves the same shape. */
  explorerUrl: string;
  /** Link root for a human, e.g. https://flare-explorer.flare.network */
  explorerSite: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** GeckoTerminal network id used for token prices; empty disables pricing. */
  geckoNetwork: string;
  /** The wrapped-native token GeckoTerminal prices, standing in for the gas token. */
  nativePriceToken: string;
  watched: Watched[];
}

export interface AppConfig {
  port: number;
  host: string;
  user: string;
  password: string;
  /** How far back the poller keeps history. */
  windowHours: number;
  /** Seconds between refreshes. */
  refreshSeconds: number;
  chains: ChainConfig[];
}

/** One transaction sent by a watched address, priced. */
export interface Trade {
  chain: string;
  hash: string;
  from: string;
  fromLabel: string;
  to: string | null;
  blockNumber: number;
  /** Unix seconds. */
  timestamp: number;
  /** 1 landed, 0 reverted. */
  status: number;
  gasUsed: number;
  effectiveGasPrice: string;
  /** Native units. */
  gasNative: number;
  gasUsd: number | null;
  /** The token the transaction left behind with a watched address, if any. */
  profitToken: string | null;
  profitSymbol: string | null;
  profitRaw: string | null;
  profitUsd: number | null;
  /** `profitUsd - gasUsd`; null when either side is unpriced. */
  netUsd: number | null;
}

export interface Totals {
  sent: number;
  landed: number;
  reverted: number;
  grossUsd: number;
  gasUsd: number;
  netUsd: number;
  /** Trades whose profit token has no price; their gross is missing from the totals. */
  unpriced: number;
}
