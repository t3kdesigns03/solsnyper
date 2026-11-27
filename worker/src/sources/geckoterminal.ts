import type { DiscoveredMint, MarketSnapshot } from "../types";
import { chunk, getJson, num, numOrNull } from "./http";

// GeckoTerminal public API (no key). Docs: https://apiguide.geckoterminal.com
// Discovery: /networks/solana/new_pools (newest pools, 20 per page).
// Pricing:   /networks/solana/tokens/multi/{<=30 addrs}?include=top_pools, keeping
//            each token's deepest pool. Also used to re-price open positions.
// Free tier is ~30 calls/min. A 45s tick makes 1 + ceil(n/30) calls (n = mints
// seen this tick, usually <=80), i.e. ~4-6 per minute.

const BASE = "https://api.geckoterminal.com/api/v2/networks/solana";
const NET = "solana_";

type Window = "m5" | "m15" | "m30" | "h1" | "h6" | "h24";

interface Rel {
  data?: { id: string; type: string } | null;
}

export interface GeckoPool {
  id: string;
  type: "pool";
  attributes: {
    address: string;
    name?: string;
    base_token_price_usd?: string | null;
    quote_token_price_usd?: string | null;
    pool_created_at?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string | null;
    price_change_percentage?: Partial<Record<Window, string | null>>;
    transactions?: Partial<Record<Window, { buys?: number; sells?: number; buyers?: number; sellers?: number }>>;
    volume_usd?: Partial<Record<Window, string | null>>;
  };
  relationships?: { base_token?: Rel; quote_token?: Rel; dex?: Rel };
}

interface GeckoToken {
  id: string;
  type: "token";
  attributes: { address: string; name?: string; symbol?: string; price_usd?: string | null; fdv_usd?: string | null };
  relationships?: { top_pools?: { data?: { id: string; type: string }[] } };
}

interface Doc<T> {
  data: T;
  included?: (GeckoPool | GeckoToken | { id: string; type: string })[];
}

const strip = (id: string | undefined | null) => (id?.startsWith(NET) ? id.slice(NET.length) : id ?? "");

export async function discoverGeckoTerminal(): Promise<DiscoveredMint[]> {
  const doc = await getJson<Doc<GeckoPool[]>>(`${BASE}/new_pools?include=base_token&page=1`);
  const symbols = new Map<string, string>();
  for (const inc of doc.included ?? []) {
    if (inc.type === "token") symbols.set(inc.id, (inc as GeckoToken).attributes.symbol ?? "");
  }
  const out: DiscoveredMint[] = [];
  for (const p of Array.isArray(doc.data) ? doc.data : []) {
    const baseId = p.relationships?.base_token?.data?.id;
    const mint = strip(baseId);
    if (mint.length > 30) out.push({ mint, source: "geckoterminal:new_pools", hintSymbol: symbols.get(baseId!) || undefined });
  }
  return out;
}

/** Market snapshots for up to N mints (30 per request), using each token's deepest pool. */
export async function fetchGeckoSnapshots(mints: string[], now: number): Promise<Map<string, MarketSnapshot>> {
  const unique = [...new Set(mints)];
  const out = new Map<string, MarketSnapshot>();
  const results = await Promise.allSettled(
    chunk(unique, 30).map((b) => getJson<Doc<GeckoToken[]>>(`${BASE}/tokens/multi/${b.join(",")}?include=top_pools`)),
  );
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === "rejected") {
      errors.push(String(r.reason));
      continue;
    }
    const pools = new Map<string, GeckoPool>();
    for (const inc of r.value.included ?? []) if (inc.type === "pool") pools.set(inc.id, inc as GeckoPool);
    for (const t of Array.isArray(r.value.data) ? r.value.data : []) {
      let best: MarketSnapshot | null = null;
      for (const ref of t.relationships?.top_pools?.data ?? []) {
        const pool = pools.get(ref.id);
        const snap = pool ? geckoToSnapshot(pool, t, now) : null;
        if (snap && (!best || snap.liquidityUsd > best.liquidityUsd)) best = snap;
      }
      if (best && unique.includes(best.mint)) out.set(best.mint, best);
    }
  }
  if (out.size === 0 && errors.length && unique.length) throw new Error(errors.join("; "));
  return out;
}

export function geckoToSnapshot(p: GeckoPool, t: GeckoToken, now: number): MarketSnapshot | null {
  const mint = t.attributes?.address;
  if (!p?.attributes || !mint) return null;
  const a = p.attributes;
  // Our token can be either side of the pool; use the matching side's price.
  const isBase = strip(p.relationships?.base_token?.data?.id) === mint;
  const isQuote = strip(p.relationships?.quote_token?.data?.id) === mint;
  if (!isBase && !isQuote) return null;
  const poolPrice = num(isBase ? a.base_token_price_usd : a.quote_token_price_usd);
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
  const createdMs = Number.isFinite(created) ? created : null;
  const tx = (w: Window) => ({ buys: num(a.transactions?.[w]?.buys), sells: num(a.transactions?.[w]?.sells) });
  // Pool-level change/age only describe our token when it is the base side.
  return {
    mint,
    symbol: t.attributes.symbol || "?",
    name: t.attributes.name || "",
    pairAddress: a.address ?? null,
    dexId: p.relationships?.dex?.data?.id ?? null,
    priceUsd: poolPrice || num(t.attributes.price_usd),
    liquidityUsd: num(a.reserve_in_usd),
    fdvUsd: numOrNull(t.attributes.fdv_usd ?? a.fdv_usd ?? a.market_cap_usd),
    volumeH1Usd: num(a.volume_usd?.h1),
    volumeM5Usd: num(a.volume_usd?.m5),
    volumeH24Usd: num(a.volume_usd?.h24),
    volumeH6Usd: num(a.volume_usd?.h6),
    priceChangeH6Pct: isBase ? numOrNull(a.price_change_percentage?.h6) : null,
    priceChangeH24Pct: isBase ? numOrNull(a.price_change_percentage?.h24) : null,
    buyersH1: num(a.transactions?.h1?.buyers),
    sellersH1: num(a.transactions?.h1?.sellers),
    txnsH1: tx("h1"),
    txnsM5: tx("m5"),
    priceChangeM5Pct: isBase ? numOrNull(a.price_change_percentage?.m5) : null,
    priceChangeH1Pct: isBase ? numOrNull(a.price_change_percentage?.h1) : null,
    pairCreatedAt: createdMs,
    ageMinutes: createdMs ? Math.max(0, (now - createdMs) / 60_000) : null,
  };
}

/**
 * Established pools for the stable lane: GeckoTerminal "trending" + "top by
 * 24h volume" on Solana. Both lists include the base token, so they give
 * discovery AND a full snapshot in one call each (no extra price lookups).
 */
export async function discoverGeckoEstablished(now: number): Promise<{ mints: DiscoveredMint[]; snapshots: MarketSnapshot[]; errors: string[] }> {
  const feeds: [string, string][] = [
    ["geckoterminal:trending", `${BASE}/trending_pools?include=base_token&page=1`],
    ["geckoterminal:top_volume", `${BASE}/pools?include=base_token&page=1&sort=h24_volume_usd_desc`],
  ];
  const results = await Promise.allSettled(feeds.map(([, url]) => getJson<Doc<GeckoPool[]>>(url)));
  const mints: DiscoveredMint[] = [];
  const snaps = new Map<string, MarketSnapshot>();
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push(`${feeds[i][0]}: ${String(r.reason)}`);
      return;
    }
    const tokens = new Map<string, GeckoToken>();
    for (const inc of r.value.included ?? []) if (inc.type === "token") tokens.set(inc.id, inc as GeckoToken);
    for (const p of Array.isArray(r.value.data) ? r.value.data : []) {
      const t = tokens.get(p.relationships?.base_token?.data?.id ?? "");
      const snap = t ? geckoToSnapshot(p, t, now) : null;
      if (!snap) continue;
      mints.push({ mint: snap.mint, source: feeds[i][0], hintSymbol: snap.symbol });
      const prev = snaps.get(snap.mint);
      if (!prev || snap.liquidityUsd > prev.liquidityUsd) snaps.set(snap.mint, snap);
    }
  });
  return { mints, snapshots: [...snaps.values()], errors };
}
