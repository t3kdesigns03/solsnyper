import type { Config } from "../config";
import type { OpenPosition } from "../types";

// Exit rules. Same pattern as filters: pure functions, first match wins,
// order = priority. Triggers use the raw price move (fees are applied to the
// fill, not the trigger), so "-8%" means price is 8% below entry.
//
// Note on realism: we only see prices every ~45s, so a stop can "gap" — the
// simulated fill is the price we observed, which may be worse than -8%. That
// is closer to reality than pretending we filled at exactly -8%.

export interface ExitContext {
  now: number;
  cfg: Config;
  /** latest observed price/liquidity; price null if the feed lost this token */
  price: number | null;
  liquidity: number | null;
}

export interface ExitRule {
  name: string;
  check(p: OpenPosition, ctx: ExitContext): string | null;
}

// Tiny tolerance so float noise (0.92/1 - 1 = -0.0799999...) still trips a -8% stop.
const EPS = 1e-9;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

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
    check: (p, { cfg, price }) => {
      if (price === null) return null;
      const chg = price / p.entry_price - 1;
      return chg <= cfg.exits.hardStopPct + EPS ? `hard stop ${pct(chg)}` : null;
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
    check: (p, { cfg, price }) => {
      if (price === null) return null;
      const chg = price / p.entry_price - 1;
      return chg >= cfg.exits.takeProfitPct - EPS ? `take profit ${pct(chg)}` : null;
    },
  },
  {
    name: "giveback",
    check: (p, { cfg, price }) => {
      if (price === null) return null;
      const peak = Math.max(p.peak_price, price);
      const peakGain = peak / p.entry_price - 1;
      if (peakGain < cfg.exits.givebackArmAtGainPct) return null;
      const gain = price / p.entry_price - 1;
      const givenBack = (peakGain - gain) / peakGain;
      return givenBack >= cfg.exits.givebackFraction
        ? `gave back ${(givenBack * 100).toFixed(0)}% of ${pct(peakGain)} peak (now ${pct(gain)})`
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
