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
  entry_fee_usd: number; // cash spent beyond size_usd on entry (the buy's network fee)
  dex_id: string | null;
  entry_liquidity: number;
  current_price: number;
  current_liquidity: number | null;
  peak_price: number;
  missed_updates: number;
}

// An order decided on one tick and filled on a later one (CONFIG.costs.fillDelayTicks).
export interface PendingOrder {
  id: number;
  side: "buy" | "sell";
  mint: string;
  symbol: string;
  position_id: number | null; // sells only
  signal_price: number; // observed price when the decision was made
  signal_time: number;
  reason: string; // buys: why it was bought; sells: "rule: reason"
  score: number | null;
  ticks_waited: number;
}

export interface Env {
  DB: D1Database;
  SCHEDULER: DurableObjectNamespace;
  ADMIN_TOKEN?: string; // optional secret; required for POST /api/run and /api/reset
  ALLOWED_ORIGIN?: string; // dashboard origins: "*" or comma-separated list ("*" if unset)
  ENABLE_PUMPFUN?: string; // "false" to disable the unofficial pump.fun source
  ENABLE_GECKOTERMINAL?: string; // "false" to disable GeckoTerminal (primary price source)
  ENABLE_DEXSCREENER?: string; // "false" to disable DexScreener (discovery + price fallback)
  ENABLE_RELAY?: string; // "false" = kill switch: stop calling the Netlify relay, go direct
  RELAY_URL?: string; // Netlify market relay endpoint
  RELAY_TOKEN?: string; // secret shared with the relay (x-relay-token)
  MOCK_MARKET?: string; // "true" = offline fake market for local testing only
}
