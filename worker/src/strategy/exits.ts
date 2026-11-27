import type { Config } from "../config";
import type { OpenPosition } from "../types";

// Exit rules. Same pattern as filters: pure functions, first match wins,
// order = priority.
//
// Trigger basis (CONFIG.exits.exitTriggerBasis):
//   "net"   (default): take-profit, stop and give-back compare NET P&L after
//           all costs (entry costs already paid + estimated exit DEX fee, gas
//           and slippage), as a share of the cash put in. "+25%" = +25% net.
//   "price": compare the raw price move vs. your fill price.
// The hard stop ALWAYS fires on whichever of the two hits first, so a stop can
// never be skipped because of how costs are estimated.
//
// Note on realism: we only see prices every ~45s, so a stop can "gap": the
// simulated fill is the price we observe later, which may be worse than -8%.

export interface ExitContext {
  now: number;
  cfg: Config;
  /** latest observed price/liquidity; price null if the feed lost this token */
  price: number | null;
  liquidity: number | null;
  /**
   * Net P&L fraction if the position were sold at `price` now (after every
   * cost). Supplied by planTick; without it, triggers fall back to price.
   */
  netAt?: (price: number) => number;
}

export interface ExitRule {
  name: string;
  check(p: OpenPosition, ctx: ExitContext): string | null;
}

// Tiny tolerance so float noise (0.92/1 - 1 = -0.0799999...) still trips a -8% stop.
const EPS = 1e-9;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

/** The move a trigger compares, in the configured basis, plus a label for the reason text. */
function gain(p: OpenPosition, price: number, ctx: ExitContext): { value: number; label: string; priceMove: number } {
  const priceMove = price / p.entry_price - 1;
  if (ctx.cfg.exits.exitTriggerBasis === "net" && ctx.netAt) {
    const net = ctx.netAt(price);
    return { value: net, label: `${pct(net)} net (${pct(priceMove)} price)`, priceMove };
  }
  return { value: priceMove, label: pct(priceMove), priceMove };
}

export const EXIT_RULES: ExitRule[] = [
  {
    name: "stale_price",
    check: (p, { cfg, price }) =>
      price === null && p.missed_updates + 1 >= cfg.exits.maxMissedUpdates
        ? `no price for ${p.missed_updates + 1} ticks, closing at last seen price`
        : null,
  },
  {
    name: "hard_stop",
    check: (p, ctx) => {
      if (ctx.price === null) return null;
      const g = gain(p, ctx.price, ctx);
      const stop = ctx.cfg.exits.hardStopPct + EPS;
      // Fires on the configured basis OR the raw price move, whichever is hit first.
      return g.value <= stop || g.priceMove <= stop ? `hard stop ${g.label}` : null;
    },
  },
  {
    name: "liquidity_collapse",
    check: (p, { cfg, liquidity }) =>
      liquidity !== null && p.entry_liquidity > 0 && liquidity < p.entry_liquidity * cfg.exits.liquidityCollapseFraction
        ? `liquidity fell to ${((liquidity / p.entry_liquidity) * 100).toFixed(0)}% of entry (rug risk)`
        : null,
  },
  {
    name: "take_profit",
    check: (p, ctx) => {
      if (ctx.price === null) return null;
      const g = gain(p, ctx.price, ctx);
      return g.value >= ctx.cfg.exits.takeProfitPct - EPS ? `take profit ${g.label}` : null;
    },
  },
  {
    name: "giveback",
    check: (p, ctx) => {
      if (ctx.price === null) return null;
      const peak = gain(p, Math.max(p.peak_price, ctx.price), ctx).value;
      if (peak < ctx.cfg.exits.givebackArmAtGainPct) return null;
      const now = gain(p, ctx.price, ctx);
      const givenBack = (peak - now.value) / peak;
      return givenBack >= ctx.cfg.exits.givebackFraction
        ? `gave back ${(givenBack * 100).toFixed(0)}% of ${pct(peak)} peak (now ${now.label})`
        : null;
    },
  },
  {
    name: "max_hold",
    check: (p, { cfg, now }) => {
      const mins = (now - p.entry_time) / 60_000;
      return mins >= cfg.exits.maxHoldMinutes - EPS ? `max hold ${mins.toFixed(1)}m` : null;
    },
  },
];

export interface ExitResult {
  rule: string;
  reason: string;
}

export function evaluateExit(p: OpenPosition, ctx: ExitContext, rules = EXIT_RULES): ExitResult | null {
  for (const r of rules) {
    const reason = r.check(p, ctx);
    if (reason) return { rule: r.name, reason };
  }
  return null;
}
