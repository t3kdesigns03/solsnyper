// Normalised market snapshot for one token. Every source + filter + exit rule
// works on this shape, so adding a new data source only means producing it.
export interface MarketSnapshot {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string | null;
  dexId: string | null;
  priceUsd: number;
  liquidityUsd: number;
  fdvUsd: number | null;
  volumeH1Usd: number;
  volumeM5Usd: number;
  txnsH1: { buys: number; sells: number };
  txnsM5: { buys: number; sells: number };
  priceChangeM5Pct: number | null;
  priceChangeH1Pct: number | null;
  pairCreatedAt: number | null; // unix ms
  ageMinutes: number | null;
}

// A mint some discovery source told us about (before we have pair data).
export interface DiscoveredMint {
  mint: string;
  source: string; // e.g. "dexscreener:profiles", "pumpfun"
  hintSymbol?: string;
}

export interface OpenPosition {
  id: number;
  mint: string;
  symbol: string;
  entry_price: number;
  entry_time: number;
  size_usd: number;
  quantity: number;
  entry_fee_usd: number;
  entry_liquidity: number;
  current_price: number;
  current_liquidity: number | null;
  peak_price: number;
  missed_updates: number;
}

export interface Env {
  DB: D1Database;
  SCHEDULER: DurableObjectNamespace;
  ADMIN_TOKEN?: string; // optional secret; required for POST /api/run and /api/reset
  ALLOWED_ORIGIN?: string; // CORS origin for the dashboard, "*" if unset
  ENABLE_PUMPFUN?: string; // "false" to disable the unofficial pump.fun source
  ENABLE_GECKOTERMINAL?: string; // "false" to disable GeckoTerminal (primary price source)
  ENABLE_DEXSCREENER?: string; // "false" to disable DexScreener (discovery + price fallback)
  MOCK_MARKET?: string; // "true" = offline fake market for local testing only
}
