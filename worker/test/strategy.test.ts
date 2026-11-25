import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { planTick } from "../src/strategy/decide";
import { evaluateEntry } from "../src/strategy/filters";
import { evaluateExit } from "../src/strategy/exits";
import { simulateBuy, simulateSell } from "../src/strategy/broker";
import type { OpenPosition } from "../src/types";
import { T0, snap } from "./fixtures";

const ctx = { now: T0, cfg: CONFIG, held: new Set<string>(), recentlyTraded: new Map<string, number>() };

describe("entry filters", () => {
  it("passes a healthy new pair", () => {
    expect(evaluateEntry(snap(), ctx).passed).toBe(true);
  });
  it.each([
    [{ liquidityUsd: 19_999 }, "liquidity"],
    [{ ageMinutes: 90 }, "age"],
    [{ ageMinutes: null }, "age"],
    [{ txnsH1: { buys: 200, sells: 1 } }, "sellable"],
    [{ fdvUsd: 50_000 * 41 }, "fdv_vs_liquidity"],
    [{ priceChangeM5Pct: 300 }, "not_vertical"],
    [{ priceUsd: 0 }, "has_price"],
  ] as const)("rejects %o via %s", (over, rule) => {
    const r = evaluateEntry(snap(over as any), ctx);
    expect(r.passed).toBe(false);
    expect(r.rule).toBe(rule);
  });
  it("respects re-entry cooldown", () => {
    const r = evaluateEntry(snap(), { ...ctx, recentlyTraded: new Map([[snap().mint, T0 - 10 * 60_000]]) });
    expect(r.rule).toBe("cooldown");
  });
});

describe("broker fees", () => {
  it("charges 0.8% round trip", () => {
    const b = simulateBuy(20, 0.001, 0.008);
    expect(b.feeUsd).toBeCloseTo(0.08);
    expect(b.cashOut).toBeCloseTo(20.08);
    const s = simulateSell({ quantity: b.quantity, size_usd: 20, entry_fee_usd: b.feeUsd }, 0.001, 0.008);
    expect(s.pnlUsd).toBeCloseTo(-0.16); // flat price => lose exactly the fees
  });
});

function pos(over: Partial<OpenPosition> = {}): OpenPosition {
  return {
    id: 1, mint: "M", symbol: "M", entry_price: 1, entry_time: T0, size_usd: 20, quantity: 20,
    entry_fee_usd: 0.08, entry_liquidity: 50_000, current_price: 1, current_liquidity: 50_000,
    peak_price: 1, missed_updates: 0, ...over,
  };
}
const ex = (p: OpenPosition, price: number | null, mins = 1, liquidity: number | null = 50_000) =>
  evaluateExit(p, { now: T0 + mins * 60_000, cfg: CONFIG, price, liquidity })?.rule ?? null;

describe("exit rules", () => {
  it("holds inside the band", () => expect(ex(pos(), 1.05)).toBeNull());
  it("hard stop at -8%", () => expect(ex(pos(), 0.92)).toBe("hard_stop"));
  it("take profit at +25%", () => expect(ex(pos(), 1.25)).toBe("take_profit"));
  it("max hold at 12m", () => expect(ex(pos(), 1.02, 12)).toBe("max_hold"));
  it("give-back after a +20% peak falls to +7%", () => expect(ex(pos({ peak_price: 1.2 }), 1.07)).toBe("giveback"));
  it("no give-back when the peak never armed (+8%)", () => expect(ex(pos({ peak_price: 1.08 }), 1.01)).toBeNull());
  it("liquidity collapse", () => expect(ex(pos(), 1.0, 1, 10_000)).toBe("liquidity_collapse"));
  it("stale price after 4 missed ticks", () => expect(ex(pos({ missed_updates: 3 }), null)).toBe("stale_price"));
});

describe("planTick", () => {
  it("buys the best passing candidates up to the per-tick cap and logs every decision", () => {
    const mints = ["A", "B", "C", "D"].map((m) => `Mint${m}`.padEnd(40, "1"));
    const snaps = new Map(mints.map((m, i) => [m, snap({ mint: m, symbol: m.slice(4, 5), liquidityUsd: 30_000 + i * 50_000, volumeH1Usd: 30_000 + i * 50_000 })]));
    snaps.set("MintBad".padEnd(40, "1"), snap({ mint: "MintBad".padEnd(40, "1"), liquidityUsd: 5_000 }));
    const discovered = [...snaps.keys(), "MintMissing".padEnd(40, "1")].map((m) => ({ mint: m, source: "test" }));
    const plan = planTick({ now: T0, cfg: CONFIG, cashUsd: 1000, open: [], discovered, snapshots: snaps, recentlyTraded: new Map() });

    expect(plan.buys.map((b) => b.snap.symbol)).toEqual(["D", "C", "B"]); // deepest liquidity scores highest
    expect(plan.cashAfter).toBeCloseTo(1000 - 3 * 20.08);
    expect(plan.decisions.filter((d) => d.action === "skip")).toHaveLength(1);
    expect(plan.decisions.filter((d) => d.action === "reject")).toHaveLength(2);
    expect(plan.equityAfter).toBeCloseTo(1000 - 3 * 0.16, 6);
  });

  it("is deterministic", () => {
    const input = { now: T0, cfg: CONFIG, cashUsd: 1000, open: [], discovered: [{ mint: snap().mint, source: "t" }], snapshots: new Map([[snap().mint, snap()]]), recentlyTraded: new Map() };
    expect(JSON.stringify(planTick(input))).toBe(JSON.stringify(planTick(input)));
  });

  it("does not buy without cash", () => {
    const plan = planTick({ now: T0, cfg: CONFIG, cashUsd: 10, open: [], discovered: [{ mint: snap().mint, source: "t" }], snapshots: new Map([[snap().mint, snap()]]), recentlyTraded: new Map() });
    expect(plan.buys).toHaveLength(0);
    expect(plan.decisions[0].reason).toMatch(/insufficient cash/);
  });
});
