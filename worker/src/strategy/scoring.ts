import type { MarketSnapshot } from "../types";

// Deterministic 0-100 score, used to RANK candidates that already passed the
// filters (best first) when we can only buy a few per tick. Swap in a better
// model later; it only has to return a number.

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function scoreCandidate(s: MarketSnapshot): number {
  // Deeper liquidity is safer (log-scaled, $20k -> 0, $500k -> 1).
  const liq = clamp01(Math.log10(Math.max(s.liquidityUsd, 1) / 20_000) / Math.log10(25));
  // Turnover: 1h volume relative to liquidity (1x -> 1).
  const turnover = clamp01(s.liquidityUsd > 0 ? s.volumeH1Usd / s.liquidityUsd : 0);
  // Buy pressure in the last 5m (fallback 1h).
  const t = s.txnsM5.buys + s.txnsM5.sells > 0 ? s.txnsM5 : s.txnsH1;
  const total = t.buys + t.sells;
  const buyRatio = total > 0 ? t.buys / total : 0.5;
  const pressure = clamp01((buyRatio - 0.4) / 0.4); // 40% -> 0, 80% -> 1
  // Freshness: newer is better within the window (0m -> 1, 60m -> 0).
  const fresh = s.ageMinutes === null ? 0 : clamp01(1 - s.ageMinutes / 60);

  const score = 30 * liq + 25 * turnover + 25 * pressure + 20 * fresh;
  return Math.round(score * 10) / 10;
}
