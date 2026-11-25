import type { Sources } from "../engine";
import type { MarketSnapshot } from "../types";

// Offline market for local testing (MOCK_MARKET="true"). A fixed universe of
// fake tokens whose prices follow a deterministic function of time, so the
// whole pipeline (DO alarm -> tick -> D1 -> API -> dashboard) can be exercised
// without network access. Never enable this in production.

const N = 24;
const EPOCH = 1_700_000_000_000;

function hash(n: number) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function token(i: number, now: number): MarketSnapshot {
  // each token "launches" on its own 90-minute cycle, so new ones keep appearing
  const cycle = 90 * 60_000;
  const offset = hash(i) * cycle;
  const born = Math.floor((now - EPOCH - offset) / cycle) * cycle + EPOCH + offset;
  const gen = Math.floor((born - EPOCH) / cycle);
  const seed = i * 1000 + gen;
  const age = (now - born) / 60_000;
  const base = 0.0001 + hash(seed) * 0.003;
  const drift = (hash(seed + 1) - 0.45) * 0.03; // per minute
  const wobble = 0.08 * Math.sin(age / (1 + hash(seed + 2) * 3)) + 0.04 * Math.sin(age * 2.7 + seed);
  const price = base * Math.max(0.05, Math.exp(drift * age + wobble));
  const liq = 4_000 + hash(seed + 3) * 120_000;
  const rug = hash(seed + 4) < 0.1 && age > 6; // 10% of tokens get rugged after 6 minutes
  const buys = Math.floor(20 + hash(seed + 5) * 400);
  const sells = hash(seed + 6) < 0.08 ? 0 : Math.floor(buys * (0.3 + hash(seed + 7) * 0.6));
  const mint = `Mock${String(i).padStart(2, "0")}g${gen}`.padEnd(43, "x");
  return {
    mint,
    symbol: `MOCK${i}`,
    name: `Mock token ${i}`,
    pairAddress: `pair-${mint}`,
    dexId: i % 3 === 0 ? "pumpfun" : "raydium",
    priceUsd: rug ? price * 0.2 : price,
    liquidityUsd: rug ? liq * 0.15 : liq,
    fdvUsd: liq * (4 + hash(seed + 8) * 50),
    volumeH1Usd: liq * hash(seed + 9) * 1.5,
    volumeM5Usd: liq * hash(seed + 10) * 0.2,
    txnsH1: { buys, sells },
    txnsM5: { buys: Math.floor(buys / 8), sells: Math.floor(sells / 8) },
    priceChangeM5Pct: (drift * 5 + wobble * 0.3) * 100,
    priceChangeH1Pct: drift * 60 * 100,
    pairCreatedAt: born,
    ageMinutes: age,
  };
}

export const mockSources: Sources = {
  async discover() {
    const now = Date.now();
    return { mints: Array.from({ length: N }, (_, i) => ({ mint: token(i, now).mint, source: "mock" })), errors: [] };
  },
  async snapshots(mints, now) {
    const all = Array.from({ length: N }, (_, i) => token(i, now));
    return new Map(all.filter((t) => mints.includes(t.mint)).map((t) => [t.mint, t]));
  },
  async solPrice() {
    return 200;
  },
};
