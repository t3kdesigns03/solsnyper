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
  totalFees: number; // all trading costs (DEX fees + network fees + slippage)
  costs: CostTotals;
  pendingOrders: number;
  costExamples: CostExamples;
  openPositions: number;
  unrealizedPnl: number;
  exposureUsd: number;
  lastRun: { started_at: number; duration_ms: number; candidates_seen: number; buys: number; sells: number; errors: string | null } | null;
  scheduler: { nextAlarm: number | null; paused: boolean } | null;
  config: {
    tickIntervalMs: number;
    wallet: { buySizeUsd: number; maxOpenPositions: number; maxBuysPerTick: number };
    costs: CostSettings;
    filters: { minLiquidityUsd: number; maxAgeMinutes: number };
    exits: { hardStopPct: number; takeProfitPct: number; maxHoldMinutes: number };
  };
}

export interface CostTotals {
  dexFeesUsd: number;
  networkFeesUsd: number;
  slippageUsd: number;
  totalUsd: number;
}

export interface CostSettings {
  dexFeePct: Record<string, number>;
  networkFeeSol: number;
  priorityFeeSol: number;
  fallbackSolPriceUsd: number;
  extraSlippagePct: number;
  fillDelayTicks: number;
}

export interface CostExamples {
  sizeUsd: number;
  solPriceUsd: number;
  legacyFlatUsd: number;
  rows: { label: string; dexId: string; liquidityUsd: number; totalUsd: number; pctOfSize: number; dexFeeUsd: number; networkFeeUsd: number; slippageUsd: number }[];
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
  // cost breakdown (0 / null for rows from before the cost model)
  dex_id?: string | null;
  entry_signal_price?: number | null;
  exit_signal_price?: number | null;
  entry_dex_fee_usd?: number;
  entry_network_fee_usd?: number;
  entry_slippage_usd?: number;
  exit_dex_fee_usd?: number;
  exit_network_fee_usd?: number;
  exit_slippage_usd?: number;
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
  action: "buy" | "reject" | "skip" | "sell" | "order" | "cancel" | "error";
  reason: string;
  score: number | null;
  timestamp: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
  cash: number;
}
