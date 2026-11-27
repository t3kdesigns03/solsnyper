// Fake data so the dashboard renders before the Worker is deployed
// (used only when NEXT_PUBLIC_API_URL is unset). Seeded, so it's stable.
import type { Candidate, Decision, EquityPoint, Position, Summary, Trade } from "./types";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const SYMS = ["BONKZ", "WIFHAT", "GIGA", "MOODENG2", "PNUTX", "CHILLGUY", "FARTBUX", "SNEK", "RETARDIO", "MEW2", "POPCAT3", "ZEREBRO", "AIXBT", "GOAT2"];
const mintFor = (i: number) => {
  const r = rng(i + 7);
  const abc = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from({ length: 44 }, () => abc[Math.floor(r() * abc.length)]).join("") ;
};

function build() {
  const now = Date.now();
  const r = rng(42);
  const start = 1000;

  const equity: EquityPoint[] = [];
  let eq = start;
  for (let i = 300; i >= 0; i--) {
    eq += (r() - 0.48) * 2.2;
    equity.push({ t: now - i * 4.8 * 60_000, equity: eq, cash: eq - 60 });
  }

  const reasons = [
    "liquidity $8,420 < $20,000",
    "too old (184m > 60m)",
    "only 1 sells in 1h (possible honeypot)",
    "FDV/liquidity 63x > 40x",
    "no Solana pair on DexScreener yet",
    "1h volume $2,310 < $5,000",
    "5m change +212% (chasing)",
  ];
  const candidates: Candidate[] = SYMS.map((s, i) => {
    const pass = i % 5 === 1;
    return {
      mint: mintFor(i), symbol: s, source: i % 3 === 0 ? "pumpfun" : "dexscreener:profiles", dex_id: i % 3 === 0 ? "pumpfun" : "raydium",
      liquidity: pass ? 25_000 + r() * 90_000 : r() * 40_000, volume: r() * 90_000, age_minutes: r() * 90, price: r() * 0.003,
      flagged: pass ? 1 : 0, reject_reason: pass ? null : reasons[i % reasons.length], score: Math.round(r() * 800) / 10, last_seen: now - Math.floor(r() * 40_000),
    };
  });

  const positions: Position[] = [0, 1, 2].map((i) => {
    const entry = 0.0001 + r() * 0.002;
    const cur = entry * (0.94 + r() * 0.26);
    return {
      id: 100 + i, mint: mintFor(20 + i), symbol: SYMS[(i * 4 + 1) % SYMS.length], entry_price: entry, entry_time: now - (1 + i * 3.5) * 60_000,
      size_usd: 20, current_price: cur, peak_price: Math.max(entry, cur) * 1.03, unrealized_pnl: 20 * (cur / entry) * 0.996 - 20.08,
      status: "open", exit_price: null, exit_time: null, realized_pnl: null, close_reason: null,
    };
  });

  const exits = ["take_profit: take profit +27.4%", "hard_stop: hard stop -9.1%", "max_hold: max hold 12.0m", "giveback: gave back 64% of +18.0% peak (now +6.5%)", "liquidity_collapse: liquidity fell to 31% of entry (rug risk)"];
  const closed: Position[] = Array.from({ length: 9 }, (_, i) => {
    const entry = 0.0002 + r() * 0.002;
    const move = [1.274, 0.909, 1.02, 1.065, 0.71][i % 5];
    const exitT = now - (i + 1) * 9 * 60_000;
    return {
      id: 90 - i, mint: mintFor(40 + i), symbol: SYMS[(i * 3 + 2) % SYMS.length], entry_price: entry, entry_time: exitT - 6 * 60_000, size_usd: 20,
      current_price: entry * move, peak_price: entry * Math.max(1, move) * 1.04, unrealized_pnl: 0, status: "closed",
      exit_price: entry * move, exit_time: exitT, realized_pnl: 20 * move * 0.984 - 20.1 - 0.1, close_reason: exits[i % 5],
      dex_id: i % 2 ? "raydium" : "pumpswap", entry_signal_price: entry * 0.993, exit_signal_price: entry * move * 1.01,
      entry_dex_fee_usd: 0.05, entry_network_fee_usd: 0.1, entry_slippage_usd: 0.11, exit_dex_fee_usd: 0.05 * move, exit_network_fee_usd: 0.1, exit_slippage_usd: 0.11 * move,
    };
  });

  const trades: Trade[] = closed.flatMap((p) => [
    { id: p.id * 2, mint: p.mint, symbol: p.symbol, side: "sell" as const, price: p.exit_price!, size_usd: 20 * (p.exit_price! / p.entry_price), fees_usd: 0.08, pnl_usd: p.realized_pnl!, reason: p.close_reason!, timestamp: p.exit_time! },
    { id: p.id * 2 - 1, mint: p.mint, symbol: p.symbol, side: "buy" as const, price: p.entry_price, size_usd: 20, fees_usd: 0.08, pnl_usd: 0, reason: "score 61.2", timestamp: p.entry_time },
  ]);

  const decisions: Decision[] = [
    ...closed.slice(0, 3).map((p, i) => ({ id: 500 - i, mint: p.mint, action: "sell" as const, reason: p.close_reason!, score: null, timestamp: p.exit_time! })),
    ...positions.map((p, i) => ({ id: 600 - i, mint: p.mint, action: "buy" as const, reason: "passed all filters, $20 paper buy", score: 55 + i * 4, timestamp: p.entry_time })),
    ...candidates.filter((c) => !c.flagged).map((c, i) => ({ id: 400 - i, mint: c.mint, action: "reject" as const, reason: c.reject_reason!, score: c.score, timestamp: c.last_seen })),
    { id: 300, mint: candidates[6].mint, action: "skip" as const, reason: "max 3 buys per tick", score: 48.2, timestamp: now - 50_000 },
  ].sort((a, b) => b.timestamp - a.timestamp);

  const realized = closed.reduce((a, p) => a + (p.realized_pnl ?? 0), 0);
  const unreal = positions.reduce((a, p) => a + p.unrealized_pnl, 0);
  const summary: Summary = {
    simulated: true,
    wallet: { cash_sol: (start + realized - 60.24) / 235, cash_usd: start + realized - 60.24, equity_usd: start + realized + unreal, starting_equity: start, sol_price_usd: 235, updated_at: now - 12_000 },
    realizedPnl: realized, closedTrades: closed.length, wins: closed.filter((p) => (p.realized_pnl ?? 0) > 0).length, totalFees: 0,
    costs: { dexFeesUsd: 0.9, networkFeesUsd: 1.8, slippageUsd: 2.05, totalUsd: 4.75 },
    pendingOrders: 1,
    costExamples: {
      sizeUsd: 20, solPriceUsd: 200, legacyFlatUsd: 0.16,
      rows: [
        { label: "pump.fun curve, $25k", dexId: "pumpfun", liquidityUsd: 25_000, totalUsd: 0.857, pctOfSize: 0.0428, dexFeeUsd: 0.395, networkFeeUsd: 0.202, slippageUsd: 0.259 },
        { label: "PumpSwap, $25k", dexId: "pumpswap", liquidityUsd: 25_000, totalUsd: 0.583, pctOfSize: 0.0291, dexFeeUsd: 0.119, networkFeeUsd: 0.202, slippageUsd: 0.261 },
        { label: "Raydium, $25k", dexId: "raydium", liquidityUsd: 25_000, totalUsd: 0.563, pctOfSize: 0.0281, dexFeeUsd: 0.099, networkFeeUsd: 0.202, slippageUsd: 0.261 },
        { label: "Raydium, $250k", dexId: "raydium", liquidityUsd: 250_000, totalUsd: 0.507, pctOfSize: 0.0253, dexFeeUsd: 0.099, networkFeeUsd: 0.202, slippageUsd: 0.205 },
      ],
    },
    openPositions: positions.length, unrealizedPnl: unreal, exposureUsd: 60,
    lastRun: { started_at: now - 12_000, duration_ms: 840, candidates_seen: candidates.length, buys: 0, sells: 1, errors: "pumpfun: 403 Forbidden from frontend-api-v3.pump.fun" },
    scheduler: { nextAlarm: now + 33_000, paused: false },
    config: {
      tickIntervalMs: 45_000, wallet: { buySizeUsd: 100, maxBuySizeUsd: 250, maxPoolSharePct: 0.005, maxOpenPositions: 10, maxBuysPerTick: 3 },
      costs: { dexFeePct: { pumpfun: 0.01, pumpswap: 0.003, raydium: 0.0025, meteora: 0.003, orca: 0.003, default: 0.003 }, networkFeeSol: 0.000005, priorityFeeSol: 0.0005, fallbackSolPriceUsd: 150, extraSlippagePct: 0.005, fillDelayTicks: 1, usePatientPriorityFee: false, patientPriorityFeeSol: 0.0001 },
      costControl: { maxRoundTripCostPct: 0.03, minEdgeMultiple: 2, skipBondingCurves: true, maxLiquidityDropAtFillPct: 0.3, maxBuysPerHour: 12, symbolCooldownMinutes: 0 },
      filters: { minLiquidityUsd: 20_000, maxLiquidityUsd: 80_000, minScore: 50, maxAgeMinutes: 60 }, exits: { hardStopPct: -0.08, takeProfitPct: 0.25, maxHoldMinutes: 12 },
    },
  };
  equity[equity.length - 1].equity = summary.wallet.equity_usd;

  return { summary, candidates, positions, closed, trades, decisions, equity };
}

let cache: ReturnType<typeof build> | null = null;

export function demoData(path: string): unknown {
  cache ??= build();
  const p = path.split("?")[0];
  switch (p) {
    case "/api/summary": return cache.summary;
    case "/api/candidates": return cache.candidates;
    case "/api/positions": return cache.positions;
    case "/api/closed": return cache.closed;
    case "/api/trades": return cache.trades;
    case "/api/decisions": return cache.decisions;
    case "/api/equity": return cache.equity;
    default: return { error: `no demo data for ${p}` };
  }
}
