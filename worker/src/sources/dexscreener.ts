import type { DiscoveredMint, MarketSnapshot } from "../types";
import { chunk, getJson, num, numOrNull } from "./http";

// DexScreener public API (no key). Docs: https://docs.dexscreener.com/api/reference
// There is no official "new pairs" endpoint, so discovery uses the two "latest"
// feeds (new token profiles + new boosts), filtered to Solana. Pair data then
// comes from /tokens/v1, which is also how open positions get re-priced.
// Rate limits (per docs): 60 rpm for profiles/boosts, 300 rpm for tokens. A 45s
// tick makes ~2 + ceil(n/30) calls, far below both.

const BASE = "https://api.dexscreener.com";

interface ProfileRow {
  chainId: string;
  tokenAddress: string;
}

export async function discoverDexScreener(): Promise<DiscoveredMint[]> {
  const feeds: [string, string][] = [
    ["dexscreener:profiles", `${BASE}/token-profiles/latest/v1`],
    ["dexscreener:boosts", `${BASE}/token-boosts/latest/v1`],
  ];
  const results = await Promise.allSettled(feeds.map(([, url]) => getJson<ProfileRow[]>(url)));
  const out: DiscoveredMint[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push(`${feeds[i][0]}: ${String(r.reason)}`);
      return;
    }
    for (const row of Array.isArray(r.value) ? r.value : []) {
      if (row?.chainId === "solana" && row.tokenAddress) {
        out.push({ mint: row.tokenAddress, source: feeds[i][0] });
      }
    }
  });
  if (out.length === 0 && errors.length) throw new Error(errors.join("; "));
  return out;
}

// Raw pair as returned by DexScreener (only the fields we use).
export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

/** Fetch market snapshots for up to N mints (30 per request). Keeps the deepest Solana pair per mint. */
export async function fetchSnapshots(mints: string[], now: number): Promise<Map<string, MarketSnapshot>> {
  const unique = [...new Set(mints)];
  const out = new Map<string, MarketSnapshot>();
  const batches = chunk(unique, 30);
  const results = await Promise.allSettled(
    batches.map((b) => getJson<DexPair[]>(`${BASE}/tokens/v1/solana/${b.join(",")}`)),
  );
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === "rejected") {
      errors.push(String(r.reason));
      continue;
    }
    for (const p of Array.isArray(r.value) ? r.value : []) {
      const snap = toSnapshot(p, now);
      if (!snap || !unique.includes(snap.mint)) continue; // ignore pairs where our mint is the quote
      const prev = out.get(snap.mint);
      if (!prev || snap.liquidityUsd > prev.liquidityUsd) out.set(snap.mint, snap);
    }
  }
  if (out.size === 0 && errors.length && unique.length) throw new Error(errors.join("; "));
  return out;
}

export function toSnapshot(p: DexPair, now: number): MarketSnapshot | null {
  if (!p || p.chainId !== "solana" || !p.baseToken?.address) return null;
  const created = numOrNull(p.pairCreatedAt);
  return {
    mint: p.baseToken.address,
    symbol: p.baseToken.symbol || "?",
    name: p.baseToken.name || "",
    pairAddress: p.pairAddress ?? null,
    dexId: p.dexId ?? null,
    priceUsd: num(p.priceUsd),
    liquidityUsd: num(p.liquidity?.usd),
    liquidityUnknown: !(num(p.liquidity?.usd) > 0),
    fdvUsd: numOrNull(p.fdv ?? p.marketCap),
    volumeH1Usd: num(p.volume?.h1),
    volumeM5Usd: num(p.volume?.m5),
    volumeH24Usd: num(p.volume?.h24),
    volumeH6Usd: num(p.volume?.h6),
    priceChangeH6Pct: numOrNull(p.priceChange?.h6),
    priceChangeH24Pct: numOrNull(p.priceChange?.h24),
    txnsH1: { buys: num(p.txns?.h1?.buys), sells: num(p.txns?.h1?.sells) },
    txnsM5: { buys: num(p.txns?.m5?.buys), sells: num(p.txns?.m5?.sells) },
    priceChangeM5Pct: numOrNull(p.priceChange?.m5),
    priceChangeH1Pct: numOrNull(p.priceChange?.h1),
    pairCreatedAt: created,
    ageMinutes: created ? Math.max(0, (now - created) / 60_000) : null,
  };
}

const WSOL = "So11111111111111111111111111111111111111112";

/** SOL/USD, only used to display cash in SOL. Returns null on failure. */
export async function fetchSolPrice(now: number): Promise<number | null> {
  try {
    const snaps = await fetchSnapshots([WSOL], now);
    return snaps.get(WSOL)?.priceUsd || null;
  } catch {
    return null;
  }
}
