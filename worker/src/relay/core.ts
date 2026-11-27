import { discoverDexScreener, fetchSnapshots } from "../sources/dexscreener";
import { discoverGeckoEstablished, discoverGeckoTerminal, fetchGeckoSnapshots } from "../sources/geckoterminal";
import { fetchRiskSummaries, type RiskSummary } from "../sources/rugcheck";
import type { DiscoveredMint, MarketSnapshot } from "../types";

// Market relay: runs on Netlify (AWS), because GeckoTerminal and DexScreener
// rate-limit Cloudflare Workers' shared egress IPs. The Worker makes ONE call
// per tick; this does every upstream call in that one run and returns only the
// fields the strategy uses. Shared by the Netlify function and the tests.

export const WSOL = "So11111111111111111111111111111111111111112";
export const MAX_MINTS = 300; // held + pump.fun + watchlist (feature store)
export const MAX_RISK_MINTS = 8; // RugCheck lookups per call (results are cached by the Worker)

export interface RelayRequest {
  mints: string[]; // held + pump.fun mints the Worker already knows about
  dexscreener?: boolean; // default true
  established?: boolean; // default true: also fetch trending / top-volume pools (stable lane)
  riskMints?: string[]; // mints to look up on RugCheck (max MAX_RISK_MINTS)
}

export interface RelayResponse {
  discovered: DiscoveredMint[]; // brand-new pools (sniper lane)
  established: DiscoveredMint[]; // trending / top-volume pools (stable lane)
  snapshots: MarketSnapshot[];
  solPriceUsd: number | null;
  risk?: Record<string, RiskSummary>; // RugCheck summaries for riskMints that succeeded
  errors: string[];
}

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Validates an untrusted request body. Returns null if it is unusable. */
export function parseRelayRequest(body: unknown): RelayRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.mints)) return null;
  const mints = [...new Set(b.mints.filter((m): m is string => typeof m === "string" && MINT_RE.test(m)))].slice(0, MAX_MINTS);
  const riskMints = Array.isArray(b.riskMints)
    ? [...new Set(b.riskMints.filter((m): m is string => typeof m === "string" && MINT_RE.test(m)))].slice(0, MAX_RISK_MINTS)
    : [];
  return { mints, dexscreener: b.dexscreener !== false, established: b.established !== false, riskMints };
}

/** Rounds to 6 significant digits; keeps the payload small without losing meaningful precision. */
const sig = (n: number) => (Number.isFinite(n) && n !== 0 ? Number(n.toPrecision(6)) : n);
const sigOrNull = (n: number | null) => (n === null ? null : sig(n));

export function trimSnapshot(s: MarketSnapshot): MarketSnapshot {
  return {
    mint: s.mint,
    symbol: s.symbol.slice(0, 24),
    name: s.name.slice(0, 48),
    pairAddress: s.pairAddress,
    dexId: s.dexId,
    priceUsd: sig(s.priceUsd),
    liquidityUsd: Math.round(s.liquidityUsd),
    fdvUsd: s.fdvUsd === null ? null : Math.round(s.fdvUsd),
    volumeH1Usd: Math.round(s.volumeH1Usd),
    volumeM5Usd: Math.round(s.volumeM5Usd),
    volumeH24Usd: s.volumeH24Usd === undefined ? undefined : Math.round(s.volumeH24Usd),
    volumeH6Usd: s.volumeH6Usd === undefined ? undefined : Math.round(s.volumeH6Usd),
    priceChangeH6Pct: s.priceChangeH6Pct === undefined ? undefined : sigOrNull(s.priceChangeH6Pct),
    priceChangeH24Pct: s.priceChangeH24Pct === undefined ? undefined : sigOrNull(s.priceChangeH24Pct),
    buyersH1: s.buyersH1,
    sellersH1: s.sellersH1,
    txnsH1: s.txnsH1,
    txnsM5: s.txnsM5,
    priceChangeM5Pct: sigOrNull(s.priceChangeM5Pct),
    priceChangeH1Pct: sigOrNull(s.priceChangeH1Pct),
    pairCreatedAt: s.pairCreatedAt,
    ageMinutes: s.ageMinutes === null ? null : Math.round(s.ageMinutes * 10) / 10,
  };
}

export async function buildMarketResponse(req: RelayRequest, now = Date.now()): Promise<RelayResponse> {
  const errors: string[] = [];

  // Phase 1: discovery (parallel).
  const jobs: [string, () => Promise<DiscoveredMint[]>][] = [["geckoterminal", discoverGeckoTerminal]];
  if (req.dexscreener !== false) jobs.push(["dexscreener", discoverDexScreener]);
  const [found, est, rc] = await Promise.all([
    Promise.allSettled(jobs.map(([, fn]) => fn())),
    req.established !== false ? discoverGeckoEstablished(now) : Promise.resolve({ mints: [], snapshots: [], errors: [] }),
    req.riskMints?.length ? fetchRiskSummaries(req.riskMints) : Promise.resolve({ risk: {}, errors: [] as string[] }),
  ]);
  errors.push(...est.errors, ...rc.errors);
  const discovered: DiscoveredMint[] = [];
  found.forEach((r, i) => {
    if (r.status === "fulfilled") discovered.push(...r.value);
    else errors.push(`${jobs[i][0]}: ${String(r.reason)}`);
  });

  // Phase 2: prices for everything the Worker asked about + what we just found + SOL.
  const wanted = [...new Set([...req.mints, ...discovered.map((d) => d.mint), WSOL])].slice(0, MAX_MINTS + 1);
  // Established pools already came with full snapshots; only price the rest.
  const snaps = new Map<string, MarketSnapshot>(est.snapshots.map((s) => [s.mint, s]));
  const toPrice = wanted.filter((m) => !snaps.has(m));
  try {
    for (const [k, v] of await fetchGeckoSnapshots(toPrice, now)) snaps.set(k, v);
  } catch (e) {
    errors.push(`geckoterminal snapshots: ${String(e)}`);
  }
  const missing = wanted.filter((m) => !snaps.has(m));
  if (missing.length && req.dexscreener !== false) {
    try {
      for (const [k, v] of await fetchSnapshots(missing, now)) snaps.set(k, v);
    } catch (e) {
      errors.push(`dexscreener snapshots: ${String(e)}`);
    }
  }

  const sol = snaps.get(WSOL);
  snaps.delete(WSOL);
  return {
    discovered,
    established: est.mints,
    snapshots: [...snaps.values()].map(trimSnapshot),
    solPriceUsd: sol?.priceUsd || null,
    risk: rc.risk,
    errors,
  };
}
