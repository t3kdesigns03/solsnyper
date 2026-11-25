import { describe, expect, it } from "vitest";
import { runTick, type Sources } from "../src/engine";
import type { Env, MarketSnapshot } from "../src/types";
import { makeD1 } from "./d1shim";
import { T0, snap } from "./fixtures";

// Runs several real ticks against SQLite with a scripted price path.
describe("runTick end-to-end (SQLite-backed D1 shim)", () => {
  it("buys, marks to market, takes profit, and keeps the books balanced", async () => {
    const { d1, raw } = makeD1();
    const env = { DB: d1 } as unknown as Env;
    const mint = snap().mint;
    let price = 0.001;
    const sources: Sources = {
      discover: async () => ({ mints: [{ mint, source: "test" }, { mint: "Junk".padEnd(40, "1"), source: "pumpfun" }], errors: ["pumpfun: 403 (test)"] }),
      snapshots: async (mints, now) => {
        const m = new Map<string, MarketSnapshot>();
        if (mints.includes(mint)) m.set(mint, snap({ priceUsd: price, ageMinutes: 15 + (now - T0) / 60_000 }));
        return m;
      },
      solPrice: async () => 200,
    };

    await runTick(env, T0, sources); // buy
    let w = raw.prepare("SELECT * FROM wallet").get() as any;
    expect(w.cash_usd).toBeCloseTo(1000 - 20.08);
    expect(w.cash_sol).toBeCloseTo((1000 - 20.08) / 200);

    price = 0.0011; // +10%
    await runTick(env, T0 + 45_000, sources);
    const p = raw.prepare("SELECT * FROM positions WHERE status='open'").get() as any;
    expect(p.peak_price).toBeCloseTo(0.0011);
    expect(p.unrealized_pnl).toBeCloseTo(20 * 1.1 * 0.996 - 20.08);

    price = 0.0013; // +30% => take profit
    await runTick(env, T0 + 90_000, sources);
    const closed = raw.prepare("SELECT * FROM positions").get() as any;
    expect(closed.status).toBe("closed");
    expect(closed.close_reason).toMatch(/^take_profit/);
    const sell = raw.prepare("SELECT * FROM trades WHERE side='sell'").get() as any;
    const expectedPnl = 20 * 1.3 * 0.996 - 20.08;
    expect(sell.pnl_usd).toBeCloseTo(expectedPnl);
    w = raw.prepare("SELECT * FROM wallet").get() as any;
    expect(w.cash_usd).toBeCloseTo(1000 + expectedPnl);
    expect(w.equity_usd).toBeCloseTo(1000 + expectedPnl);

    // Cooldown: next tick must not re-buy the same mint.
    await runTick(env, T0 + 135_000, sources);
    expect((raw.prepare("SELECT COUNT(*) n FROM positions").get() as any).n).toBe(1);

    // Junk reject logged once (unchanged reason not re-logged), errors captured in runs.
    const junk = raw.prepare("SELECT COUNT(*) n FROM decisions WHERE mint LIKE 'Junk%'").get() as any;
    expect(junk.n).toBe(1);
    expect((raw.prepare("SELECT errors FROM runs LIMIT 1").get() as any).errors).toMatch(/pumpfun/);
    expect((raw.prepare("SELECT COUNT(*) n FROM equity_snapshots").get() as any).n).toBe(4);
  });
});
