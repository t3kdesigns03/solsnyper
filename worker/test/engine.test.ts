import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { runTick, type Sources } from "../src/engine";
import { simulateBuy, simulateSell } from "../src/strategy/broker";
import { tradeSizeUsd } from "../src/strategy/filters";
import type { Env, MarketSnapshot } from "../src/types";
import { makeD1 } from "./d1shim";
import { T0, snap } from "./fixtures";

// Runs several real ticks against SQLite with a scripted price path, using the
// default config (realistic costs, fills one tick after the decision).
describe("runTick end-to-end (SQLite-backed D1 shim)", () => {
  it("orders, fills next tick with costs, takes profit, and keeps the books balanced", async () => {
    const { d1, raw } = makeD1();
    const env = { DB: d1 } as unknown as Env;
    const mint = snap().mint;
    const SOL = 200;
    const LIQ = 50_000;
    let price = 0.001;
    const sources: Sources = {
      discover: async () => ({ mints: [{ mint, source: "test" }, { mint: "Junk".padEnd(40, "1"), source: "pumpfun" }], errors: ["pumpfun: 403 (test)"] }),
      snapshots: async (mints, now) => {
        const m = new Map<string, MarketSnapshot>();
        if (mints.includes(mint)) m.set(mint, snap({ priceUsd: price, liquidityUsd: LIQ, ageMinutes: 15 + (now - T0) / 60_000 }));
        return m;
      },
      solPrice: async () => SOL,
    };
    const q = (sql: string) => raw.prepare(sql).get() as any;

    // Tick 0: signal -> pending buy order, no cash moves yet.
    await runTick(env, T0, sources);
    expect(q("SELECT COUNT(*) n FROM pending_orders WHERE side='buy'").n).toBe(1);
    expect(q("SELECT COUNT(*) n FROM positions").n).toBe(0);
    expect(q("SELECT cash_usd FROM wallet").cash_usd).toBe(1000);

    // Tick 1: price moved +2% before we could buy; the order fills at THAT price, plus costs.
    price = 0.00102;
    await runTick(env, T0 + 45_000, sources);
    const m1 = { price, liquidityUsd: LIQ, dexId: "raydium", solPriceUsd: SOL };
    // $50k pool: liquidity-aware sizing scales the $100 base up (max 0.5% of the pool, cost cap permitting).
    const size = tradeSizeUsd(snap({ priceUsd: price, liquidityUsd: LIQ }), CONFIG, SOL);
    expect(size).toBeGreaterThan(CONFIG.wallet.buySizeUsd);
    expect(size).toBeLessThanOrEqual(LIQ * CONFIG.wallet.maxPoolSharePct);
    const buy = simulateBuy(size, m1, CONFIG.costs);
    let p = q("SELECT * FROM positions WHERE status='open'");
    expect(p.entry_signal_price).toBe(0.001);
    expect(p.entry_price).toBeCloseTo(buy.fillPrice, 12);
    expect(p.entry_price).toBeGreaterThan(price);
    expect(p.size_usd).toBe(size);
    expect(p.entry_dex_fee_usd).toBeCloseTo(0.0025 * size); // raydium 0.25%
    expect(p.entry_signal_liquidity).toBe(LIQ);
    expect(p.entry_score).toBeGreaterThan(0);
    expect(p.entry_network_fee_usd).toBeCloseTo(0.000505 * SOL);
    expect(p.dex_id).toBe("raydium");
    expect(q("SELECT cash_usd FROM wallet").cash_usd).toBeCloseTo(1000 - buy.cashOut);
    expect(q("SELECT COUNT(*) n FROM pending_orders").n).toBe(0);

    // Tick 2: +30% over fill => take-profit signal -> pending sell order.
    price = buy.fillPrice * 1.3;
    await runTick(env, T0 + 90_000, sources);
    expect(q("SELECT status FROM positions").status).toBe("open");
    expect(q("SELECT side FROM pending_orders").side).toBe("sell");

    // Tick 3: sell fills at the new (lower) price.
    const signal = price;
    price = signal * 0.97;
    await runTick(env, T0 + 135_000, sources);
    p = q("SELECT * FROM positions");
    expect(p.status).toBe("closed");
    expect(p.close_reason).toMatch(/^take_profit/);
    expect(p.exit_signal_price).toBeCloseTo(signal, 12);
    const sold = simulateSell({ quantity: buy.quantity, size_usd: size, entry_fee_usd: buy.cashOut - size }, { ...m1, price }, CONFIG.costs);
    expect(p.realized_pnl).toBeCloseTo(sold.pnlUsd, 9);
    const t = q("SELECT * FROM trades WHERE side='sell'");
    expect(t.pnl_usd).toBeCloseTo(sold.pnlUsd, 9);
    expect(t.dex_fee_usd + t.network_fee_usd + t.slippage_usd).toBeCloseTo(sold.costs.totalUsd, 9);
    const w = q("SELECT * FROM wallet");
    expect(w.cash_usd).toBeCloseTo(1000 + sold.pnlUsd, 9);
    expect(w.equity_usd).toBeCloseTo(1000 + sold.pnlUsd, 9);

    // Cooldown: no re-buy, no new order.
    await runTick(env, T0 + 180_000, sources);
    expect(q("SELECT COUNT(*) n FROM positions").n).toBe(1);
    expect(q("SELECT COUNT(*) n FROM pending_orders").n).toBe(0);

    // Junk reject logged once (unchanged reason not re-logged), errors captured in runs.
    expect(q("SELECT COUNT(*) n FROM decisions WHERE mint LIKE 'Junk%'").n).toBe(1);
    expect(q("SELECT errors FROM runs LIMIT 1").errors).toMatch(/pumpfun/);
    expect(q("SELECT COUNT(*) n FROM equity_snapshots").n).toBe(5);
  });
});
