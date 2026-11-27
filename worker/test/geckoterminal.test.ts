import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGeckoSnapshots, geckoToSnapshot, type GeckoPool } from "../src/sources/geckoterminal";

const MINT = "2QQz1s4uPWZ3o6aaXpn3sKTr7fRmpP6QyXohypf8pump";
const WSOL = "So11111111111111111111111111111111111111112";
const NOW = Date.parse("2026-11-27T18:30:00Z");

const pool = (id: string, base: string, quote: string, reserve: string, extra: Partial<GeckoPool["attributes"]> = {}): GeckoPool => ({
  id: `solana_${id}`,
  type: "pool",
  attributes: {
    address: id,
    base_token_price_usd: "0.0000043",
    quote_token_price_usd: "72.5",
    pool_created_at: "2026-11-27T18:15:00Z",
    fdv_usd: "4300",
    reserve_in_usd: reserve,
    price_change_percentage: { m5: "12.5", h1: "-3" },
    transactions: { m5: { buys: 7, sells: 2 }, h1: { buys: 40, sells: 11 } },
    volume_usd: { m5: "900.5", h1: "6100" },
    ...extra,
  },
  relationships: {
    base_token: { data: { id: `solana_${base}`, type: "token" } },
    quote_token: { data: { id: `solana_${quote}`, type: "token" } },
    dex: { data: { id: "pump-fun", type: "dex" } },
  },
});

const token = (addr: string, pools: string[], symbol = "FRI") => ({
  id: `solana_${addr}`,
  type: "token" as const,
  attributes: { address: addr, name: "Black Friday", symbol, price_usd: "0.0000044", fdv_usd: "4400" },
  relationships: { top_pools: { data: pools.map((p) => ({ id: `solana_${p}`, type: "pool" })) } },
});

describe("geckoToSnapshot", () => {
  it("maps a pool where our token is the base", () => {
    const s = geckoToSnapshot(pool("P1", MINT, WSOL, "25000"), token(MINT, ["P1"]), NOW)!;
    expect(s).toMatchObject({
      mint: MINT,
      symbol: "FRI",
      pairAddress: "P1",
      dexId: "pump-fun",
      priceUsd: 0.0000043,
      liquidityUsd: 25000,
      fdvUsd: 4400,
      volumeH1Usd: 6100,
      volumeM5Usd: 900.5,
      txnsH1: { buys: 40, sells: 11 },
      txnsM5: { buys: 7, sells: 2 },
      priceChangeM5Pct: 12.5,
      priceChangeH1Pct: -3,
    });
    expect(s.ageMinutes).toBe(15);
  });

  it("uses the quote price and drops pool price-change when our token is the quote", () => {
    const s = geckoToSnapshot(pool("P2", "OtherBase1111111111111111111111111111111111", WSOL, "1000000"), token(WSOL, ["P2"], "SOL"), NOW)!;
    expect(s.priceUsd).toBe(72.5);
    expect(s.priceChangeM5Pct).toBeNull();
  });

  it("rejects a pool that doesn't contain the token", () => {
    expect(geckoToSnapshot(pool("P3", "A".repeat(43), "B".repeat(43), "1"), token(MINT, ["P3"]), NOW)).toBeNull();
  });

  it("treats a null reserve as zero liquidity", () => {
    expect(geckoToSnapshot(pool("P4", MINT, WSOL, null as unknown as string), token(MINT, ["P4"]), NOW)!.liquidityUsd).toBe(0);
  });
});

describe("fetchGeckoSnapshots", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the deepest pool per token and batches 30 mints per request", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.includes(MINT)
          ? { data: [token(MINT, ["SHALLOW", "DEEP"])], included: [pool("SHALLOW", MINT, WSOL, "5000"), pool("DEEP", MINT, WSOL, "90000")] }
          : { data: [], included: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const others = Array.from({ length: 40 }, (_, i) => `Mint${i}`.padEnd(43, "x"));
    const out = await fetchGeckoSnapshots([MINT, ...others], NOW);
    expect(urls).toHaveLength(2);
    expect(out.get(MINT)?.pairAddress).toBe("DEEP");
    expect(out.size).toBe(1);
  });

  it("throws when every batch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429, statusText: "Too Many Requests" })));
    await expect(fetchGeckoSnapshots([MINT], NOW)).rejects.toThrow(/429/);
  });
});
