import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api";
import { CONFIG, STABLE_CONFIG } from "../src/config";
import { runTick, type Sources } from "../src/engine";
import { buildMarketResponse, WSOL } from "../src/relay/core";
import { markToMarket } from "../src/strategy/broker";
import { evaluateExit } from "../src/strategy/exits";
import { evaluateEntry } from "../src/strategy/filters";
import type { Env, MarketSnapshot, OpenPosition } from "../src/types";
import { makeD1 } from "./d1shim";
import { T0, snap } from "./fixtures";

const SOL = 72;

// ── exit trigger basis ───────────────────────────────────────────────────────
const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  id: 1, mint: "M", symbol: "M", entry_price: 1, entry_time: T0, size_usd: 100, quantity: 97, entry_fee_usd: 0.04,
  entry_liquidity: 50_000, current_price: 1, current_liquidity: 50_000, peak_price: 1, missed_updates: 0, dex_id: "raydium", ...over,
});
const netAtFor = (p: OpenPosition) => (px: number) =>
  markToMarket(p, { price: px, liquidityUsd: 50_000, dexId: "raydium", solPriceUsd: SOL }, CONFIG.costs).unrealizedPnl / (p.size_usd + p.entry_fee_usd);
const priceCfg = { ...CONFIG, exits: { ...CONFIG.exits, exitTriggerBasis: "price" as const } };

describe("exit trigger basis", () => {
  const p = pos();
  const ctx = (price: number, cfg = CONFIG) => ({ now: T0 + 60_000, cfg, price, liquidity: 50_000, netAt: netAtFor(p) });

  it("net: +26% price is not yet +25% net after all costs", () => {
    expect(netAtFor(p)(1.26)).toBeLessThan(0.25);
    expect(evaluateExit(p, ctx(1.26))).toBeNull();
    expect(evaluateExit(p, ctx(1.26, priceCfg))?.rule).toBe("take_profit");
  });

  it("net: take-profit fires once the NET gain reaches the target, and says both numbers", () => {
    // Find the first price where net >= +25%, then check the trigger and its reason text.
    let px = 1.25;
    while (netAtFor(p)(px) < 0.25) px += 0.005;
    expect(px).toBeGreaterThan(1.26); // costs push the price needed above +25%
    expect(evaluateExit(p, ctx(px - 0.005))).toBeNull();
    const r = evaluateExit(p, ctx(px));
    expect(r?.rule).toBe("take_profit");
    expect(r?.reason).toMatch(/^take profit \+25\.\d% net \(\+\d\d\.\d% price\)$/);
  });

  it("hard stop fires earlier on net (costs count against you) and always fires on price", () => {
    expect(evaluateExit(p, ctx(0.94))?.rule).toBe("hard_stop"); // -6% price is below -8% net
    expect(evaluateExit(p, ctx(0.94, priceCfg))).toBeNull();
    // Without a net estimate the price move still triggers it.
    expect(evaluateExit(p, { now: T0, cfg: CONFIG, price: 0.9, liquidity: 50_000 })?.rule).toBe("hard_stop");
  });
});

// ── stable lane entry rules ──────────────────────────────────────────────────
const established = (over: Partial<MarketSnapshot> = {}) =>
  snap({
    mint: "Estab1ished111111111111111111111111111111", symbol: "OLD", dexId: "raydium", liquidityUsd: 400_000, fdvUsd: 4_000_000,
    volumeH1Usd: 60_000, volumeH24Usd: 900_000, txnsH1: { buys: 300, sells: 250 }, priceChangeH1Pct: 6, priceChangeM5Pct: -1.5,
    ageMinutes: 60 * 24 * 5, pairCreatedAt: T0 - 5 * 86_400_000, ...over,
  });
const sctx = { now: T0, cfg: STABLE_CONFIG, held: new Set<string>(), recentlyTraded: new Map<string, number>(), solPriceUsd: SOL };

describe("stable lane entry rules", () => {
  it("passes an established pool in an uptrend with a small pullback", () => {
    expect(evaluateEntry(established(), sctx)).toMatchObject({ passed: true });
  });
  it.each([
    ["too new", { ageMinutes: 45 }, "age", /too new/],
    ["too thin", { liquidityUsd: 90_000, fdvUsd: 900_000 }, "liquidity", /< \$150,000/],
    ["no steady volume", { volumeH24Usd: 120_000 }, "volume_24h", /24h volume/],
    ["no uptrend", { priceChangeH1Pct: 0.5 }, "trend_1h", /no uptrend/],
    ["parabolic", { priceChangeH1Pct: 80 }, "trend_1h", /parabolic/],
    ["still ripping (no pullback)", { priceChangeM5Pct: 3 }, "not_vertical", /chasing/],
    ["falling knife", { priceChangeM5Pct: -9 }, "not_dumping", /dumping/],
  ])("rejects: %s", (_n, over, rule, reason) => {
    const r = evaluateEntry(established(over as Partial<MarketSnapshot>), sctx);
    expect(r.rule).toBe(rule);
    expect(r.reason).toMatch(reason as RegExp);
  });
  it("never trades SOL / stablecoin pools (both lanes)", () => {
    expect(evaluateEntry(established({ mint: WSOL }), sctx).rule).toBe("base_asset");
    expect(evaluateEntry(snap({ mint: WSOL }), { ...sctx, cfg: CONFIG }).rule).toBe("base_asset");
  });
  it("the sniper still rejects old pools (its rules are unchanged)", () => {
    expect(evaluateEntry(established(), { ...sctx, cfg: CONFIG }).rule).toBe("age");
  });
});

// ── both lanes in one tick ───────────────────────────────────────────────────
describe("runTick with two lanes", () => {
  it("runs both lanes on one market fetch with separate wallets and rows", async () => {
    const { d1, raw } = makeD1();
    const env = { DB: d1 } as unknown as Env;
    const young = snap(); // passes the sniper
    const old = established();
    let fetches = 0;
    const sources: Sources = {
      discover: async () => ({ mints: [{ mint: young.mint, source: "test" }], errors: [] }),
      established: async () => ({ mints: [{ mint: old.mint, source: "geckoterminal:trending" }], snapshots: [old], errors: [] }),
      snapshots: async (mints) => {
        fetches++;
        return new Map([young, old].filter((s) => mints.includes(s.mint)).map((s) => [s.mint, s]));
      },
      solPrice: async () => SOL,
    };
    const q = (sql: string) => raw.prepare(sql).all() as any[];

    const t0 = await runTick(env, T0, sources);
    expect(fetches).toBe(1);
    expect(t0.lanes.sniper.candidatesSeen).toBe(1);
    expect(t0.lanes.stable.candidatesSeen).toBe(1);
    expect(q("SELECT lane, mint FROM pending_orders ORDER BY lane")).toEqual([
      { lane: "sniper", mint: young.mint },
      { lane: "stable", mint: old.mint },
    ]);

    await runTick(env, T0 + 45_000, sources);
    const posRows = q("SELECT lane, size_usd FROM positions ORDER BY lane");
    expect(posRows.map((r) => r.lane)).toEqual(["sniper", "stable"]);
    expect(posRows[1].size_usd).toBeGreaterThanOrEqual(250); // stable base size
    const sniperCash = (raw.prepare("SELECT cash_usd FROM wallet").get() as any).cash_usd;
    const stableCash = (raw.prepare("SELECT cash_usd FROM lane_wallets WHERE lane='stable'").get() as any).cash_usd;
    expect(sniperCash).toBeLessThan(1000);
    expect(stableCash).toBeLessThan(10_000);
    expect(stableCash).toBeGreaterThan(10_000 - 600);
    expect(q("SELECT DISTINCT lane FROM trades ORDER BY lane").map((r) => r.lane)).toEqual(["sniper", "stable"]);
    expect(q("SELECT COUNT(*) n FROM lane_equity WHERE lane='stable'")[0].n).toBe(2);
    expect(q("SELECT lane, COUNT(*) n FROM runs GROUP BY lane")).toHaveLength(2);
  });
});

// ── relay: established pools in the same call ────────────────────────────────
afterEach(() => vi.unstubAllGlobals());

describe("relay established-pool feed", () => {
  it("returns trending/top pools with snapshots, without re-pricing them", async () => {
    const calls: string[] = [];
    const tokenId = "solana_Estab1ished111111111111111111111111111111";
    const pool = {
      id: "solana_POOL", type: "pool",
      attributes: { address: "POOL", base_token_price_usd: "1.5", reserve_in_usd: "400000", pool_created_at: "2026-11-20T00:00:00Z", volume_usd: { h1: "60000", h24: "900000", m5: "5000" }, transactions: { h1: { buys: 300, sells: 250 } }, price_change_percentage: { m5: "-1.5", h1: "6" } },
      relationships: { base_token: { data: { id: tokenId, type: "token" } }, quote_token: { data: { id: `solana_${WSOL}`, type: "token" } }, dex: { data: { id: "raydium", type: "dex" } } },
    };
    const token = { id: tokenId, type: "token", attributes: { address: "Estab1ished111111111111111111111111111111", symbol: "OLD", name: "Old", price_usd: "1.5" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/trending_pools") || url.includes("/pools?")) return new Response(JSON.stringify({ data: [pool], included: [token] }));
        if (url.includes("/tokens/multi/")) return new Response(JSON.stringify({ data: [], included: [] }));
        if (url.includes("/new_pools")) return new Response(JSON.stringify({ data: [], included: [] }));
        return new Response("", { status: 429, statusText: "Too Many Requests" });
      }),
    );
    const r = await buildMarketResponse({ mints: [] }, Date.parse("2026-11-27T20:00:00Z"));
    expect(r.established.map((d) => d.source).sort()).toEqual(["geckoterminal:top_volume", "geckoterminal:trending"]);
    const s = r.snapshots.find((x) => x.mint === token.attributes.address)!;
    expect(s).toMatchObject({ liquidityUsd: 400_000, volumeH24Usd: 900_000, priceChangeH1Pct: 6 });
    const priced = calls.filter((u) => u.includes("/tokens/multi/")).join(" ");
    expect(priced).not.toContain(token.attributes.address);
  });
});

// ── per-lane reset and API ───────────────────────────────────────────────────
function fakeScheduler() {
  const stub = { fetch: async () => Response.json({ paused: false, nextAlarm: null }) };
  return { idFromName: () => "id", get: () => stub } as unknown as DurableObjectNamespace;
}

describe("lane-aware API", () => {
  const setup = () => {
    const { d1, raw } = makeD1();
    const env = { DB: d1, SCHEDULER: fakeScheduler(), ADMIN_TOKEN: "t" } as unknown as Env;
    raw.exec(`INSERT INTO trades (lane, mint, symbol, side, price, size_usd, fees_usd, reason, timestamp) VALUES ('sniper','a','A','buy',1,100,0,'x',1), ('stable','b','B','buy',1,250,0,'x',1)`);
    const get = (path: string) => handleApi(new Request(`https://w${path}`), env);
    const reset = (body: unknown) =>
      handleApi(new Request("https://w/api/reset", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) }), env);
    return { raw, get, reset };
  };

  it("resets only the chosen lane", async () => {
    const { raw, reset } = setup();
    const res = await reset({ lane: "stable", startingEquity: 25_000 });
    expect(await res.json()).toMatchObject({ reset: true, lane: "stable", startingEquity: 25_000 });
    expect((raw.prepare("SELECT lane FROM trades").all() as any[]).map((r) => r.lane)).toEqual(["sniper"]);
    expect((raw.prepare("SELECT starting_equity s FROM lane_wallets WHERE lane='stable'").get() as any).s).toBe(25_000);
    expect((await reset({ lane: "nope" })).status).toBe(400);
  });

  it("serves each lane's summary and a side-by-side overview", async () => {
    const { get } = setup();
    const stable = (await (await get("/api/summary?lane=stable")).json()) as any;
    expect(stable.lane).toBe("stable");
    expect(stable.wallet.starting_equity).toBe(10_000);
    expect(stable.config.filters.minLiquidityUsd).toBe(150_000);
    const lanes = (await (await get("/api/lanes")).json()) as any[];
    expect(lanes.map((l) => l.lane)).toEqual(["sniper", "stable"]);
    expect((await get("/api/positions?lane=bogus")).status).toBe(400);
  });
});
