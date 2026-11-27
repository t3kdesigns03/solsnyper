import { afterEach, describe, expect, it, vi } from "vitest";
import { liveSources } from "../src/engine";
import { buildMarketResponse, MAX_MINTS, MAX_RISK_MINTS, parseRelayRequest, trimSnapshot, WSOL } from "../src/relay/core";
import { callRelay } from "../src/sources/relay";
import type { Env } from "../src/types";
import relayFunction from "../../web/netlify/functions/market.mts";
import { snap } from "./fixtures";

declare const process: { env: Record<string, string | undefined> };

const MINT = "2QQz1s4uPWZ3o6aaXpn3sKTr7fRmpP6QyXohypf8pump";
const NEW = "NewPoo1Token111111111111111111111111111pump";
const NOW = Date.parse("2026-11-27T18:30:00Z");

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// Minimal GeckoTerminal fake: new_pools discovers NEW; tokens/multi prices whatever was asked.
function geckoToken(addr: string, price: string) {
  return {
    data: { id: `solana_${addr}`, type: "token", attributes: { address: addr, symbol: addr.slice(0, 4), name: "n", price_usd: price }, relationships: { top_pools: { data: [{ id: `solana_P${addr}`, type: "pool" }] } } },
    pool: {
      id: `solana_P${addr}`,
      type: "pool",
      attributes: {
        address: `P${addr}`,
        base_token_price_usd: price,
        reserve_in_usd: "25000.123456",
        pool_created_at: "2026-11-27T18:00:00Z",
        volume_usd: { h1: "6100.77", m5: "900.2" },
        transactions: { h1: { buys: 40, sells: 11 }, m5: { buys: 7, sells: 2 } },
        price_change_percentage: { m5: "12.3456789", h1: "-3" },
      },
      relationships: { base_token: { data: { id: `solana_${addr}`, type: "token" } }, quote_token: { data: { id: `solana_${WSOL}`, type: "token" } } },
    },
  };
}

function fakeUpstream(calls: string[]) {
  return vi.fn(async (input: string | Request) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (url.includes("api.dexscreener.com")) return new Response("", { status: 429, statusText: "Too Many Requests" });
    if (url.includes("/new_pools")) return ok({ data: [{ id: "solana_X", type: "pool", attributes: { address: "X" }, relationships: { base_token: { data: { id: `solana_${NEW}`, type: "token" } } } }], included: [] });
    if (url.includes("/tokens/multi/")) {
      const addrs = decodeURIComponent(url.split("/tokens/multi/")[1].split("?")[0]).split(",");
      const toks = addrs.map((a) => geckoToken(a, a === WSOL ? "72.5" : "0.00001234567891"));
      return ok({ data: toks.map((t) => t.data), included: toks.map((t) => t.pool) });
    }
    return new Response("nope", { status: 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("relay core", () => {
  it("validates and caps the request", () => {
    expect(parseRelayRequest(null)).toBeNull();
    expect(parseRelayRequest({ mints: "x" })).toBeNull();
    const r = parseRelayRequest({ mints: [MINT, MINT, "bad mint!", 5, ...Array.from({ length: 400 }, (_, i) => `${i}`.padStart(40, "A"))] })!;
    expect(r.mints[0]).toBe(MINT);
    expect(r.mints).not.toContain("bad mint!");
    expect(r.mints.length).toBe(MAX_MINTS);
    const withRisk = parseRelayRequest({ mints: [], riskMints: Array.from({ length: 20 }, (_, i) => `${i}`.padStart(40, "B")) })!;
    expect(withRisk.riskMints).toHaveLength(MAX_RISK_MINTS);
    expect(r.dexscreener).toBe(true);
  });

  it("trims numbers and strings", () => {
    const t = trimSnapshot(snap({ priceUsd: 0.000012345678912, liquidityUsd: 25000.6, symbol: "X".repeat(50), ageMinutes: 15.4567 }));
    expect(t.priceUsd).toBe(0.0000123457);
    expect(t.liquidityUsd).toBe(25001);
    expect(t.symbol.length).toBe(24);
    expect(t.ageMinutes).toBe(15.5);
  });

  it("discovers, prices requested + discovered mints in one batch, splits out SOL, reports upstream errors", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", fakeUpstream(calls));
    const r = await buildMarketResponse({ mints: [MINT] }, NOW);
    expect(r.discovered).toEqual([{ mint: NEW, source: "geckoterminal:new_pools", hintSymbol: undefined }]);
    expect(r.snapshots.map((s) => s.mint).sort()).toEqual([MINT, NEW].sort());
    expect(r.snapshots[0].liquidityUsd).toBe(25000);
    expect(r.solPriceUsd).toBe(72.5);
    expect(r.errors.some((e) => e.startsWith("dexscreener: ") && e.includes("429"))).toBe(true);
    expect(calls.filter((u) => u.includes("/tokens/multi/"))).toHaveLength(1);
  });
});

describe("netlify function", () => {
  const post = (token: string | null, body: unknown) =>
    new Request("https://x/api/market", { method: "POST", headers: token ? { "x-relay-token": token } : {}, body: JSON.stringify(body) });

  it("rejects a missing or wrong token, accepts the right one", async () => {
    vi.stubGlobal("fetch", fakeUpstream([]));
    process.env.RELAY_TOKEN = "test-relay-token";
    try {
      expect((await relayFunction(post(null, { mints: [] }))).status).toBe(401);
      expect((await relayFunction(post("test-relay-tokem", { mints: [] }))).status).toBe(401);
      expect((await relayFunction(post("test-relay-token", { mints: "x" }))).status).toBe(400);
      const res = await relayFunction(post("test-relay-token", { mints: [MINT] }));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { snapshots: unknown[] }).snapshots.length).toBe(2);
    } finally {
      delete process.env.RELAY_TOKEN;
    }
  });

  it("returns 503 when RELAY_TOKEN is not configured", async () => {
    expect((await relayFunction(post("anything", { mints: [] }))).status).toBe(503);
  });
});

describe("worker relay client + fallback", () => {
  const env = { ENABLE_RELAY: "true", RELAY_URL: "https://relay.test/api/market", RELAY_TOKEN: "t", ENABLE_PUMPFUN: "false" } as unknown as Env;

  it("makes one relay call carrying held mints and the token", async () => {
    const seen: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push(new Request(url, init));
        return ok({ discovered: [{ mint: NEW, source: "geckoterminal:new_pools" }], snapshots: [snap({ mint: NEW })], solPriceUsd: 70, errors: ["dexscreener: 429"] });
      }),
    );
    const m = await liveSources.market!(env, [MINT], NOW);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get("x-relay-token")).toBe("t");
    expect(((await seen[0].json()) as { mints: string[] }).mints).toEqual([MINT]);
    expect(m.snapshots.get(NEW)).toBeTruthy();
    expect(m.solPrice).toBe(70);
    expect(m.errors).toEqual(["relay/dexscreener: 429"]);
  });

  it("falls back to direct calls when the relay fails", async () => {
    const calls: string[] = [];
    const upstream = fakeUpstream(calls);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => (url.startsWith("https://relay.test") ? new Response("", { status: 404, statusText: "Not Found" }) : upstream(url))),
    );
    const m = await liveSources.market!(env, [MINT], NOW);
    expect(m.errors[0]).toMatch(/^relay: .*404.*fell back/);
    expect(m.snapshots.has(MINT)).toBe(true);
    expect(calls.some((u) => u.includes("api.geckoterminal.com"))).toBe(true);
  });

  it("kill switch skips the relay entirely", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", fakeUpstream(calls));
    await liveSources.market!({ ...env, ENABLE_RELAY: "false" } as Env, [MINT], NOW);
    expect(calls.some((u) => u.startsWith("https://relay.test"))).toBe(false);
  });

  it("rejects a malformed relay body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ hello: 1 })));
    await expect(callRelay("https://relay.test", "t", [])).rejects.toThrow(/unexpected body/);
  });
});
