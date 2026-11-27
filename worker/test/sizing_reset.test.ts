import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api";
import { CONFIG } from "../src/config";
import { planTick } from "../src/strategy/decide";
import { evaluateEntry, poolRoundTripCostPct, tradeSizeUsd } from "../src/strategy/filters";
import type { Env } from "../src/types";
import { makeD1 } from "./d1shim";
import { T0, snap } from "./fixtures";

const SOL = 72;

describe("liquidity-aware sizing", () => {
  it("is the $100 base in pools too shallow to support more", () => {
    expect(tradeSizeUsd(snap({ liquidityUsd: 20_000 }), CONFIG, SOL)).toBe(100); // 0.5% of $20k = $100
    expect(tradeSizeUsd(snap({ liquidityUsd: 30_000 }), CONFIG, SOL)).toBe(100); // $150 would cost > 3% here
  });

  it("scales up in deeper pools, never above maxBuySizeUsd or maxPoolSharePct", () => {
    const deep = snap({ dexId: "raydium", liquidityUsd: 200_000 });
    expect(tradeSizeUsd(deep, CONFIG, SOL)).toBe(250);
    for (const liq of [25_000, 45_000, 70_000]) {
      const s = snap({ liquidityUsd: liq });
      const size = tradeSizeUsd(s, CONFIG, SOL);
      expect(size).toBeLessThanOrEqual(Math.max(100, liq * 0.005));
      if (size > 100) expect(poolRoundTripCostPct(s, CONFIG, SOL, size)).toBeLessThanOrEqual(CONFIG.costControl.maxRoundTripCostPct);
    }
  });

  it("steps back down when the bigger size would break the cost cap", () => {
    const cfg = { ...CONFIG, costControl: { ...CONFIG.costControl, maxRoundTripCostPct: 0.025 } };
    const s = snap({ dexId: "meteora", liquidityUsd: 60_000 });
    const size = tradeSizeUsd(s, cfg, SOL);
    expect(size).toBeLessThan(250);
    expect(size === 100 || poolRoundTripCostPct(s, cfg, SOL, size) <= 0.025).toBe(true);
  });
});

describe("data-driven entry rules", () => {
  const ctx = { now: T0, cfg: CONFIG, held: new Set<string>(), recentlyTraded: new Map<string, number>(), solPriceUsd: SOL };
  it("skips brand-new pools above maxLiquidityUsd", () => {
    expect(evaluateEntry(snap({ liquidityUsd: 95_000 }), ctx).rule).toBe("max_liquidity");
    expect(evaluateEntry(snap({ liquidityUsd: 95_000 }), { ...ctx, cfg: { ...CONFIG, filters: { ...CONFIG.filters, maxLiquidityUsd: 0 } } }).passed).toBe(true);
  });

  it("rejects candidates scoring below minScore, with the score as the reason", () => {
    const weak = snap({ liquidityUsd: 60_000, volumeH1Usd: 5_500, txnsH1: { buys: 20, sells: 15 }, ageMinutes: 55, pairCreatedAt: T0 - 55 * 60_000 });
    const plan = planTick({ now: T0, cfg: CONFIG, cashUsd: 10_000, solPriceUsd: SOL, open: [], discovered: [{ mint: weak.mint, source: "t" }], snapshots: new Map([[weak.mint, weak]]), recentlyTraded: new Map() });
    expect(plan.newOrders).toHaveLength(0);
    expect(plan.candidates[0].reason).toMatch(/^score [\d.]+ < 50$/);
  });
});

// Fake Durable Object namespace that records which scheduler endpoints were called.
function fakeScheduler(calls: string[]) {
  const stub = {
    fetch: async (url: string) => {
      calls.push(new URL(url).pathname);
      return Response.json(new URL(url).pathname === "/resume" ? { paused: false } : { nextAlarm: null, paused: false });
    },
  };
  return { idFromName: () => "id", get: () => stub } as unknown as DurableObjectNamespace;
}

describe("POST /api/reset", () => {
  const setup = () => {
    const { d1, raw } = makeD1();
    const calls: string[] = [];
    const env = { DB: d1, SCHEDULER: fakeScheduler(calls), ADMIN_TOKEN: "t" } as unknown as Env;
    raw.exec(`INSERT INTO trades (mint, symbol, side, price, size_usd, fees_usd, reason, timestamp) VALUES ('m','S','buy',1,100,0.3,'x',1)`);
    raw.exec(`INSERT INTO pending_orders (side, mint, symbol, signal_price, signal_time, reason) VALUES ('buy','m','S',1,1,'x')`);
    const post = (body?: unknown, token = "t") =>
      handleApi(new Request("https://w/api/reset", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { raw, calls, post };
  };

  it("wipes history, sets the starting amount, and keeps the loop running", async () => {
    const { raw, calls, post } = setup();
    const res = await post({ startingEquity: 10_000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reset: true, startingEquity: 10_000, paused: false });
    const w = raw.prepare("SELECT * FROM wallet").get() as { cash_usd: number; equity_usd: number; starting_equity: number };
    expect(w).toMatchObject({ cash_usd: 10_000, equity_usd: 10_000, starting_equity: 10_000 });
    expect((raw.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number }).n).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) n FROM pending_orders").get() as { n: number }).n).toBe(0);
    expect(calls).toContain("/resume");
  });

  it("defaults to CONFIG.wallet.startingEquityUsd with no body", async () => {
    const { raw, post } = setup();
    expect((await post()).status).toBe(200);
    expect((raw.prepare("SELECT starting_equity s FROM wallet").get() as { s: number }).s).toBe(CONFIG.wallet.startingEquityUsd);
  });

  it("rejects out-of-range amounts and a wrong token, without wiping", async () => {
    const { raw, post } = setup();
    for (const bad of [50, 2_000_000, "abc", -1]) expect((await post({ startingEquity: bad })).status).toBe(400);
    expect((await post({ startingEquity: 5000 }, "wrong")).status).toBe(401);
    expect((raw.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number }).n).toBe(1);
  });
});
