import { describe, expect, it } from "vitest";
import { CONFIG, type Config } from "../src/config";
import { networkFeeUsd, txFeeSol } from "../src/strategy/broker";
import { planTick, type TickInput } from "../src/strategy/decide";
import { evaluateEntry, poolRoundTripCostPct } from "../src/strategy/filters";
import type { PendingOrder } from "../src/types";
import { T0, snap } from "./fixtures";

const SOL = 72;
const ctx = (over: Partial<Parameters<typeof evaluateEntry>[1]> = {}) => ({
  now: T0, cfg: CONFIG, held: new Set<string>(), recentlyTraded: new Map<string, number>(), solPriceUsd: SOL, ...over,
});
const withCC = (cc: Partial<Config["costControl"]>, extra: Partial<Config> = {}): Config => ({ ...CONFIG, ...extra, costControl: { ...CONFIG.costControl, ...cc } });

describe("cost-aware entry rules", () => {
  it("rejects a pool whose round trip costs more than maxRoundTripCostPct", () => {
    const thin = snap({ dexId: "pumpfun", liquidityUsd: 25_000 }); // ~3.6% round trip
    expect(poolRoundTripCostPct(thin, CONFIG, SOL)).toBeGreaterThan(0.03);
    const r = evaluateEntry(thin, ctx({ cfg: withCC({ skipBondingCurves: false }) }));
    expect(r.rule).toBe("round_trip_cost");
    expect(r.reason).toMatch(/^round trip costs \d+\.\d% > 3\.0% max$/);
    expect(evaluateEntry(snap({ dexId: "raydium", liquidityUsd: 60_000 }), ctx()).passed).toBe(true); // ~2.3% at $100
  });

  it("rejects when take-profit is less than minEdgeMultiple x round-trip cost", () => {
    const cfg = withCC({ minEdgeMultiple: 2 }, { exits: { ...CONFIG.exits, takeProfitPct: 0.04 } });
    const r = evaluateEntry(snap({ dexId: "raydium", liquidityUsd: 60_000 }), ctx({ cfg }));
    expect(r.rule).toBe("round_trip_cost");
    expect(r.reason).toMatch(/take-profit 4% < 2x round trip cost/);
  });

  it("pump.fun curve pools never get under the default 3% cap (2% fees + 1% slippage buffer)", () => {
    expect(poolRoundTripCostPct(snap({ dexId: "pumpfun", liquidityUsd: 5_000_000 }), CONFIG, SOL)).toBeGreaterThan(0.03);
  });

  it("can skip pump.fun bonding-curve pools entirely, even with a looser cost cap", () => {
    const deep = snap({ dexId: "pumpfun", liquidityUsd: 500_000 });
    const noCeiling = { ...CONFIG.filters, maxLiquidityUsd: 0 };
    const loose = withCC({ maxRoundTripCostPct: 0.05, skipBondingCurves: false }, { filters: noCeiling });
    expect(evaluateEntry(deep, ctx({ cfg: loose })).passed).toBe(true);
    expect(evaluateEntry(deep, ctx({ cfg: withCC({ maxRoundTripCostPct: 0.05, skipBondingCurves: true }, { filters: noCeiling }) })).rule).toBe("bonding_curve");
    expect(evaluateEntry(snap({ dexId: "meteoradbc" }), ctx()).rule).toBe("bonding_curve"); // on by default
    expect(evaluateEntry(snap({ dexId: "pumpswap" }), ctx({ cfg: withCC({ skipBondingCurves: true }) })).passed).toBe(true);
  });

  it("skips a relaunch: same symbol bought recently under another mint", () => {
    const recent = new Map([["GOOD", T0 - 10 * 60_000]]);
    const on = withCC({ symbolCooldownMinutes: 120 });
    expect(evaluateEntry(snap(), ctx({ recentSymbols: recent, cfg: on })).rule).toBe("symbol_cooldown");
    expect(evaluateEntry(snap(), ctx({ recentSymbols: new Map([["GOOD", T0 - 130 * 60_000]]), cfg: on })).passed).toBe(true);
    expect(evaluateEntry(snap(), ctx({ recentSymbols: recent })).rule).toBe("symbol_cooldown"); // on by default for the sniper (120m)
    expect(evaluateEntry(snap(), ctx({ recentSymbols: recent, cfg: withCC({ symbolCooldownMinutes: 0 }) })).passed).toBe(true);
  });
});

const base = (over: Partial<TickInput> = {}): TickInput => ({
  now: T0, cfg: CONFIG, cashUsd: 1000, solPriceUsd: SOL, open: [], pending: [], discovered: [],
  snapshots: new Map(), recentlyTraded: new Map(), ...over,
});
const two = ["MintA", "MintB"].map((m) => snap({ mint: m.padEnd(40, "1"), symbol: m }));

describe("cost-aware sizing of activity", () => {
  it("caps buys per rolling hour (filled + pending orders)", () => {
    const input = base({ discovered: two.map((s) => ({ mint: s.mint, source: "t" })), snapshots: new Map(two.map((s) => [s.mint, s])) });
    expect(planTick({ ...input, buysLastHour: 12 }).newOrders).toHaveLength(0);
    const plan = planTick({ ...input, buysLastHour: 11 });
    expect(plan.newOrders).toHaveLength(1);
    expect(plan.decisions.find((d) => d.action === "skip")?.reason).toBe("max 12 buys per hour");
  });

  it("does not buy two mints with the same symbol in one tick", () => {
    const twins = two.map((s) => ({ ...s, symbol: "TWIN" }));
    const plan = planTick(base({ cfg: withCC({ symbolCooldownMinutes: 120 }), discovered: twins.map((s) => ({ mint: s.mint, source: "t" })), snapshots: new Map(twins.map((s) => [s.mint, s])) }));
    expect(plan.newOrders).toHaveLength(1);
    expect(plan.decisions.find((d) => d.action === "skip")?.reason).toMatch(/symbol TWIN already bought this tick/);
  });

  it("cancels a pending buy if the pool was drained before the fill", () => {
    const mint = snap().mint;
    const order: PendingOrder = { id: 3, side: "buy", mint, symbol: "GOOD", position_id: null, signal_price: 0.001, signal_time: T0, reason: "score 70", score: 70, ticks_waited: 0, signal_liquidity: 50_000 };
    const drained = snap({ liquidityUsd: 4 });
    const plan = planTick(base({ now: T0 + 45_000, pending: [order], snapshots: new Map([[mint, drained]]) }));
    expect(plan.buys).toHaveLength(0);
    expect(plan.closedOrders[0]).toMatchObject({ id: 3, outcome: "cancelled" });
    expect(plan.decisions[0].reason).toMatch(/liquidity fell 100% since the signal/);
    expect(plan.cashAfter).toBe(1000);
  });

  it("cancels on a partial liquidity pull, and on a thin pool even without a recorded signal liquidity", () => {
    const mint = snap().mint;
    const order = (sl: number | null): PendingOrder => ({ id: 4, side: "buy", mint, symbol: "GOOD", position_id: null, signal_price: 0.001, signal_time: T0, reason: "score 70", score: 70, ticks_waited: 0, signal_liquidity: sl });
    const pulled = planTick(base({ now: T0 + 45_000, pending: [order(60_000)], snapshots: new Map([[mint, snap({ liquidityUsd: 36_000 })]]) }));
    expect(pulled.decisions[0].reason).toMatch(/liquidity fell 40% since the signal/);
    const fine = planTick(base({ now: T0 + 45_000, pending: [order(60_000)], snapshots: new Map([[mint, snap({ liquidityUsd: 55_000 })]]) }));
    expect(fine.buys).toHaveLength(1);
    const thin = planTick(base({ now: T0 + 45_000, pending: [order(null)], snapshots: new Map([[mint, snap({ liquidityUsd: 4 })]]) }));
    expect(thin.decisions[0].reason).toMatch(/pool too thin at fill/);
  });
});

describe("patient priority fee", () => {
  it("uses the lower fee only when enabled", () => {
    expect(txFeeSol(CONFIG.costs)).toBeCloseTo(0.000505);
    const patient = { ...CONFIG.costs, usePatientPriorityFee: true };
    expect(txFeeSol(patient)).toBeCloseTo(0.000105);
    expect(networkFeeUsd(SOL, patient)).toBeCloseTo(0.000105 * SOL);
  });
});
