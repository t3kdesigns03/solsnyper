export interface Wallet {
  cash_sol: number;
  cash_usd: number;
  equity_usd: number;
  starting_equity: number;
  sol_price_usd: number;
  updated_at: number;
}

export interface Summary {
  simulated: true;
  wallet: Wallet;
  realizedPnl: number;
  closedTrades: number;
  wins: number;
  totalFees: number;
  openPositions: number;
  unrealizedPnl: number;
  exposureUsd: number;
  lastRun: { started_at: number; duration_ms: number; candidates_seen: number; buys: number; sells: number; errors: string | null } | null;
  scheduler: { nextAlarm: number | null; paused: boolean } | null;
  config: { tickIntervalMs: number; wallet: { buySizeUsd: number }; filters: { minLiquidityUsd: number; maxAgeMinutes: number }; exits: { hardStopPct: number; takeProfitPct: number; maxHoldMinutes: number } };
}

export interface Candidate {
  mint: string;
  symbol: string;
  source: string;
  dex_id: string | null;
  liquidity: number | null;
  volume: number | null;
  age_minutes: number | null;
  price: number | null;
  flagged: number;
  reject_reason: string | null;
  score: number | null;
  last_seen: number;
}

export interface Position {
  id: number;
  mint: string;
  symbol: string;
  entry_price: number;
  entry_time: number;
  size_usd: number;
  current_price: number;
  peak_price: number;
  unrealized_pnl: number;
  status: "open" | "closed";
  exit_price: number | null;
  exit_time: number | null;
  realized_pnl: number | null;
  close_reason: string | null;
}

export interface Trade {
  id: number;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size_usd: number;
  fees_usd: number;
  pnl_usd: number;
  reason: string;
  timestamp: number;
}

export interface Decision {
  id: number;
  mint: string;
  action: "buy" | "reject" | "skip" | "sell" | "error";
  reason: string;
  score: number | null;
  timestamp: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
  cash: number;
}
