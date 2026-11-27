import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { dexFeePct, markToMarket, priceImpact, roundTripCost, simulateBuy, simulateSell } from "../src/strategy/broker";
import { planTick, type TickInput } from "../src/strategy/decide";
import type { OpenPosition, PendingOrder } from "../src/types";
import { T0, snap } from "./fixtures";

const C = CONFIG.costs;
const SOL = 200;

describe("dex fee lookup", () => {
  it.each([
    ["pumpfun", 0.01],
    ["pump-fun", 0.01], // GeckoTerminal spelling
    ["PumpSwap", 0.003],
    ["raydium", 0.0025],
    ["raydium-clmm", 0.0025], // prefix match
    ["meteora-dlmm", 0.003],
    ["orca", 0.003],
    ["somethingnew", 0.003], // default
    [null, 0.003],
  ])("%s -> %s", (id, fee) => expect(dexFeePct(id, C)).toBe(fee));
});

describe("cost math", () => {
  it("$20 buy into $25k liquidity on pump.fun", () => {
    const b = simulateBuy(20, { price: 0.001, liquidityUsd: 25_000, dexId: "pumpfun", solPriceUsd: SOL }, C);
    expect(b.costs.dexFeeUsd).toBeCloseTo(0.2, 9); // 1%
    expect(priceImpact(19.8, 25_000)).toBeCloseTo(0.00158149, 7); // 19.8 / (12,500 + 19.8)
    expect(b.costs.slippageUsd).toBeCloseTo(0.130157, 5); // impact + 0.5% buffer on $19.80
    expect(b.costs.networkFeeUsd).toBeCloseTo(0.101, 9); // 0.000505 SOL * $200
    expect(b.cashOut).toBeCloseTo(20.101, 9);
    expect(b.quantity * 0.001).toBeCloseTo(19.669843, 5); // token value received at the observed price
    expect(b.fillPrice).toBeGreaterThan(0.001); // buys fill above the observed price
    expect(b.costs.totalUsd).toBeCloseTo(0.2 + 0.130157 + 0.101, 5);
  });

  it("sells fill below the observed price and P&L includes both legs", () => {
    const m = { price: 0.001, liquidityUsd: 25_000, dexId: "pumpfun", solPriceUsd: SOL };
    const b = simulateBuy(20, m, C);
    const s = simulateSell({ quantity: b.quantity, size_usd: 20, entry_fee_usd: b.cashOut - 20 }, m, C);
    expect(s.fillPrice).toBeLessThan(0.001);
    expect(s.cashIn).toBeCloseTo(19.244337, 5);
    expect(s.pnlUsd).toBeCloseTo(19.244337 - 20.101, 5);
    const rt = roundTripCost(20, m, C);
    expect(rt.totalUsd).toBeCloseTo(0.856663, 5); // vs $0.16 under the old flat 0.8%
    expect(rt.dexFeeUsd + rt.networkFeeUsd + rt.slippageUsd).toBeCloseTo(rt.totalUsd, 9);
  });

  it("deeper pools and cheaper DEXes cost less", () => {
    const at = (dexId: string, liquidityUsd: number) => roundTripCost(20, { price: 1, liquidityUsd, dexId, solPriceUsd: SOL }, C).totalUsd;
    expect(at("raydium", 25_000)).toBeLessThan(at("pumpfun", 25_000));
    expect(at("raydium", 250_000)).toBeLessThan(at("raydium", 25_000));
  });

  it("a position is never marked below zero", () => {
    const mtm = markToMarket({ quantity: 1, size_usd: 20, entry_fee_usd: 0.1 }, { price: 1e-12, liquidityUsd: 0, dexId: null, solPriceUsd: SOL }, C);
    expect(mtm.valueUsd).toBe(0);
    expect(mtm.unrealizedPnl).toBeCloseTo(-20.1);
  });
});

// ── pending orders ──────────────────────────────────────────────────────────

const mint = snap().mint;
const base = (over: Partial<TickInput> = {}): TickInput => ({
  now: T0, cfg: CONFIG, cashUsd: 1000, solPriceUsd: SOL, open: [], pending: [],
  discovered: [{ mint, source: "t" }], snapshots: new Map([[mint, snap()]]), recentlyTraded: new Map(), ...over,
});
const order = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  id: 7, side: "buy", mint, symbol: "GOOD", position_id: null, signal_price: 0.001, signal_time: T0, reason: "score 70", score: 70, ticks_waited: 0, ...over,
});
const position = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  id: 1, mint, symbol: "GOOD", entry_price: 0.001, entry_time: T0, size_usd: 20, quantity: 19_000, entry_fee_usd: 0.101,
  entry_liquidity: 50_000, current_price: 0.001, current_liquidity: 50_000, peak_price: 0.001, missed_updates: 0, dex_id: "raydium", ...over,
});

describe("pending orders (fillDelayTicks = 1)", () => {
  it("a passing candidate becomes an order, not a buy", () => {
    const plan = planTick(base());
    expect(plan.buys).toHaveLength(0);
    expect(plan.newOrders).toEqual([expect.objectContaining({ side: "buy", mint, signal_price: 0.001 })]);
    expect(plan.cashAfter).toBe(1000);
    expect(plan.decisions.find((d) => d.mint === mint)?.action).toBe("order");
  });

  it("the order fills next tick at THAT tick's price, with costs", () => {
    const later = snap({ priceUsd: 0.0012 });
    const plan = planTick(base({ now: T0 + 45_000, pending: [order()], discovered: [], snapshots: new Map([[mint, later]]) }));
    expect(plan.buys).toHaveLength(1);
    const b = plan.buys[0];
    expect(b.signalPrice).toBe(0.001);
    expect(b.fill.signalPrice).toBe(0.0012);
    expect(b.fill.fillPrice).toBeGreaterThan(0.0012);
    expect(plan.closedOrders).toEqual([{ id: 7, outcome: "filled", note: "" }]);
    expect(plan.cashAfter).toBeCloseTo(1000 - b.fill.cashOut, 9);
  });

  it("cancels when there is no price at fill time", () => {
    const plan = planTick(base({ pending: [order()], discovered: [], snapshots: new Map() }));
    expect(plan.buys).toHaveLength(0);
    expect(plan.closedOrders[0]).toMatchObject({ id: 7, outcome: "cancelled" });
  });

  it("does not place a second order for a mint with one pending", () => {
    const cfg = { ...CONFIG, costs: { ...C, fillDelayTicks: 3 } };
    const plan = planTick(base({ cfg, pending: [order()] }));
    expect(plan.newOrders).toHaveLength(0);
    expect(plan.waitingOrders).toEqual([{ id: 7, ticksWaited: 1 }]);
  });

  it("an exit becomes a sell order and fills next tick below the new price", () => {
    const dropped = snap({ priceUsd: 0.0009 }); // -10% => hard stop
    const p1 = planTick(base({ open: [position()], discovered: [], snapshots: new Map([[mint, dropped]]) }));
    expect(p1.sells).toHaveLength(0);
    expect(p1.newOrders).toEqual([expect.objectContaining({ side: "sell", position_id: 1, signal_price: 0.0009 })]);
    expect(p1.updates).toHaveLength(1); // still marked to market while waiting

    const pending = [order({ id: 9, side: "sell", position_id: 1, signal_price: 0.0009, reason: "hard_stop: hard stop -10.0%" })];
    const p2 = planTick(base({ now: T0 + 45_000, open: [position()], pending, discovered: [], snapshots: new Map([[mint, snap({ priceUsd: 0.00085 })]]) }));
    expect(p2.sells).toHaveLength(1);
    expect(p2.sells[0].rule).toBe("hard_stop");
    expect(p2.sells[0].signalPrice).toBe(0.0009);
    expect(p2.sells[0].fill.fillPrice).toBeLessThan(0.00085);
    expect(p2.newOrders).toHaveLength(0);
  });

  it("a sell order with no price waits, then closes at the last price after maxMissedUpdates", () => {
    const pending = (w: number) => [order({ id: 9, side: "sell", position_id: 1, reason: "max_hold: max hold 12.0m", ticks_waited: w })];
    const waiting = planTick(base({ open: [position()], pending: pending(0), discovered: [], snapshots: new Map() }));
    expect(waiting.sells).toHaveLength(0);
    expect(waiting.waitingOrders).toEqual([{ id: 9, ticksWaited: 1 }]);
    const forced = planTick(base({ open: [position()], pending: pending(CONFIG.exits.maxMissedUpdates - 1), discovered: [], snapshots: new Map() }));
    expect(forced.sells).toHaveLength(1);
  });

  it("fillDelayTicks = 0 buys instantly at the signal price", () => {
    const plan = planTick(base({ cfg: { ...CONFIG, costs: { ...C, fillDelayTicks: 0 } } }));
    expect(plan.newOrders).toHaveLength(0);
    expect(plan.buys).toHaveLength(1);
    expect(plan.buys[0].signalPrice).toBe(plan.buys[0].fill.signalPrice);
  });
});
