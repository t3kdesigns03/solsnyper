import type { MarketSnapshot } from "../src/types";

export const T0 = 1_764_000_000_000;

export function snap(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    mint: "MintGood1111111111111111111111111111111111",
    symbol: "GOOD",
    name: "Good Coin",
    pairAddress: "PairGood",
    dexId: "raydium",
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    fdvUsd: 500_000,
    volumeH1Usd: 40_000,
    volumeM5Usd: 6_000,
    txnsH1: { buys: 300, sells: 150 },
    txnsM5: { buys: 40, sells: 20 },
    priceChangeM5Pct: 12,
    priceChangeH1Pct: 60,
    pairCreatedAt: T0 - 15 * 60_000,
    ageMinutes: 15,
    ...over,
  };
}
