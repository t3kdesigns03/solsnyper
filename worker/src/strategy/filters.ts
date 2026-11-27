import type { Config } from "../config";
import type { MarketSnapshot } from "../types";
import { roundTripCost } from "./broker";

// Entry filters. Each rule is a pure function: return null to pass, or a short
// machine-readable reason to reject. Rules run in order and the FIRST failure
// is the logged reason, so put cheap/obvious checks first.
//
// To add a check (e.g. a real rug check from an on-chain source): write a rule,
// append it to ENTRY_RULES. If it needs extra data, add it to FilterContext and
// fill it in engine.ts.

export interface FilterContext {
  now: number;
  cfg: Config;
  /** mints with an open position */
  held: Set<string>;
  /** mint -> last exit time (ms), for re-entry cooldown */
  recentlyTraded: Map<string, number>;
  /** upper-cased symbol -> last buy time (ms) of a DIFFERENT mint with that symbol */
  recentSymbols?: Map<string, number>;
  /** SOL price for the round-trip cost estimate (0 = use the configured fallback) */
  solPriceUsd?: number;
}

/** Estimated round-trip cost of a buySizeUsd trade in this pool, as a fraction of the size. */
export function poolRoundTripCostPct(s: MarketSnapshot, cfg: Config, solPriceUsd = 0): number {
  const sol = solPriceUsd > 0 ? solPriceUsd : cfg.costs.fallbackSolPriceUsd;
  return roundTripCost(cfg.wallet.buySizeUsd, { price: s.priceUsd, liquidityUsd: s.liquidityUsd, dexId: s.dexId, solPriceUsd: sol }, cfg.costs).pctOfSize;
}

export interface EntryRule {
  name: string;
  check(s: MarketSnapshot, ctx: FilterContext): string | null;
}

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const ENTRY_RULES: EntryRule[] = [
  {
    name: "already_held",
    check: (s, { held }) => (held.has(s.mint) ? "already holding this mint" : null),
  },
  {
    name: "cooldown",
    check: (s, { recentlyTraded, now, cfg }) => {
      const t = recentlyTraded.get(s.mint);
      if (t === undefined) return null;
      const mins = (now - t) / 60_000;
      return mins < cfg.filters.reentryCooldownMinutes ? `traded ${mins.toFixed(0)}m ago (cooldown)` : null;
    },
  },
  {
    name: "has_price",
    check: (s) => (s.priceUsd > 0 ? null : "no USD price"),
  },
  {
    name: "age",
    check: (s, { cfg }) => {
      if (s.ageMinutes === null) return "unknown pair age";
      return s.ageMinutes > cfg.filters.maxAgeMinutes
        ? `too old (${s.ageMinutes.toFixed(0)}m > ${cfg.filters.maxAgeMinutes}m)`
        : null;
    },
  },
  {
    name: "liquidity",
    check: (s, { cfg }) =>
      s.liquidityUsd < cfg.filters.minLiquidityUsd
        ? `liquidity ${fmtUsd(s.liquidityUsd)} < ${fmtUsd(cfg.filters.minLiquidityUsd)}`
        : null,
  },
  {
    name: "volume",
    check: (s, { cfg }) =>
      s.volumeH1Usd < cfg.filters.minVolumeH1Usd
        ? `1h volume ${fmtUsd(s.volumeH1Usd)} < ${fmtUsd(cfg.filters.minVolumeH1Usd)}`
        : null,
  },
  {
    name: "activity",
    check: (s, { cfg }) => {
      const n = s.txnsH1.buys + s.txnsH1.sells;
      return n < cfg.filters.minTxnsH1 ? `only ${n} txns in 1h` : null;
    },
  },
  {
    name: "sellable",
    check: (s, { cfg }) =>
      s.txnsH1.sells < cfg.filters.minSellsH1
        ? `only ${s.txnsH1.sells} sells in 1h (possible honeypot)`
        : null,
  },
  {
    name: "fdv_vs_liquidity",
    check: (s, { cfg }) => {
      if (!s.fdvUsd || s.liquidityUsd <= 0) return null;
      const ratio = s.fdvUsd / s.liquidityUsd;
      return ratio > cfg.filters.maxFdvToLiquidity
        ? `FDV/liquidity ${ratio.toFixed(0)}x > ${cfg.filters.maxFdvToLiquidity}x`
        : null;
    },
  },
  {
    name: "not_vertical",
    check: (s, { cfg }) =>
      s.priceChangeM5Pct !== null && s.priceChangeM5Pct > cfg.filters.maxPriceChangeM5Pct
        ? `5m change +${s.priceChangeM5Pct.toFixed(0)}% (chasing)`
        : null,
  },
  {
    name: "not_dumping",
    check: (s, { cfg }) =>
      s.priceChangeM5Pct !== null && s.priceChangeM5Pct < cfg.filters.minPriceChangeM5Pct
        ? `5m change ${s.priceChangeM5Pct.toFixed(0)}% (dumping)`
        : null,
  },
  // ── cost control (CONFIG.costControl) ──
  {
    name: "symbol_cooldown",
    check: (s, { cfg, now, recentSymbols }) => {
      const mins = cfg.costControl.symbolCooldownMinutes;
      const t = mins > 0 ? recentSymbols?.get(s.symbol.toUpperCase()) : undefined;
      if (t === undefined) return null;
      const ago = (now - t) / 60_000;
      return ago < mins ? `symbol ${s.symbol} bought ${ago.toFixed(0)}m ago under another mint (relaunch risk)` : null;
    },
  },
  {
    name: "pumpfun_curve",
    check: (s, { cfg }) =>
      cfg.costControl.skipPumpFunCurve && /^pump[-_ ]?fun$/i.test(s.dexId ?? "")
        ? "pump.fun bonding curve (1% fee each way)"
        : null,
  },
  {
    name: "round_trip_cost",
    check: (s, { cfg, solPriceUsd }) => {
      const c = poolRoundTripCostPct(s, cfg, solPriceUsd);
      const max = cfg.costControl.maxRoundTripCostPct;
      if (c > max) return `round trip costs ${(c * 100).toFixed(1)}% > ${(max * 100).toFixed(1)}% max`;
      const need = c * cfg.costControl.minEdgeMultiple;
      return cfg.exits.takeProfitPct < need
        ? `take-profit ${(cfg.exits.takeProfitPct * 100).toFixed(0)}% < ${cfg.costControl.minEdgeMultiple}x round trip cost (${(c * 100).toFixed(1)}%)`
        : null;
    },
  },
];

export interface FilterResult {
  passed: boolean;
  rule: string | null;
  reason: string;
}

export function evaluateEntry(s: MarketSnapshot, ctx: FilterContext, rules = ENTRY_RULES): FilterResult {
  for (const r of rules) {
    const reason = r.check(s, ctx);
    if (reason) return { passed: false, rule: r.name, reason };
  }
  return { passed: true, rule: null, reason: "passed all filters" };
}
