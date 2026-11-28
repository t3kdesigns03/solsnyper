import { type Config, type Lane, LANE_CONFIG, LANES } from "./config";
import type { RiskSummary } from "./sources/rugcheck";
import type { CandidateRow } from "./strategy/decide";
import type { MarketSnapshot } from "./types";

// Feature store: records market features of tracked coins every few minutes
// (candidate_snapshots), keeps pricing them for a while after first sight
// (watchlist) and caches RugCheck summaries (token_risk). Nothing here affects
// trading; it only collects data for analysis (worker/scripts/analyze.ts).

export interface SamplingPlan {
  isSample: boolean; // any lane samples this tick
  laneSample: Partial<Record<Lane, boolean>>; // which lanes record a sample this tick
  watch: { lane: Lane; mint: string }[];
  riskMints: string[];
}

/**
 * Decide which lanes record a sample this tick (each lane has its own cadence:
 * data.sampleEveryMinutes, 0 = every tick), which watchlist coins to price,
 * and which mints need a risk lookup.
 */
export async function planSampling(db: D1Database, cfg: Config, now: number, lanes: Partial<Record<Lane, Config>> = LANE_CONFIG): Promise<SamplingPlan> {
  const d = cfg.data;
  if (!d.enabled) return { isSample: false, laneSample: {}, watch: [], riskMints: [] };
  const lastByLane = new Map(
    (await db.prepare("SELECT lane, MAX(t) AS t FROM candidate_snapshots GROUP BY lane").all<{ lane: Lane; t: number }>()).results.map((r) => [r.lane, r.t]),
  );
  const laneSample: Partial<Record<Lane, boolean>> = {};
  for (const l of LANES) {
    const lc = lanes[l];
    if (!lc || !lc.data.enabled) continue;
    // 5s slack so a 3-minute cadence isn't skipped by tick jitter
    laneSample[l] = now - (lastByLane.get(l) ?? 0) >= lc.data.sampleEveryMinutes * 60_000 - 5_000;
  }
  const sampling = LANES.filter((l) => laneSample[l]);
  const isSample = sampling.length > 0;
  const watch = isSample
    ? (
        await db
          .prepare(`SELECT lane, mint FROM watchlist WHERE until > ? AND lane IN (${sampling.map(() => "?").join(",")}) ORDER BY first_seen DESC LIMIT ?`)
          .bind(now, ...sampling, d.maxWatchlist)
          .all<{ lane: Lane; mint: string }>()
      ).results
    : [];
  const riskMints =
    d.riskLookupsPerTick > 0
      ? (
          await db
            .prepare(
              "SELECT DISTINCT w.mint AS mint FROM watchlist w LEFT JOIN token_risk r ON r.mint = w.mint WHERE r.mint IS NULL AND w.until > ? ORDER BY w.first_seen DESC LIMIT ?",
            )
            .bind(now, d.riskLookupsPerTick)
            .all<{ mint: string }>()
        ).results.map((r) => r.mint)
      : [];
  return { isSample, laneSample, watch, riskMints };
}

/** Does a lane want to track this candidate? */
export function shouldTrack(s: MarketSnapshot, cfg: Config): boolean {
  const d = cfg.data;
  if (s.priceUsd <= 0 || s.liquidityUsd < d.trackMinLiquidityUsd) return false;
  if (d.trackMaxAgeMinutes > 0 && (s.ageMinutes === null || s.ageMinutes > d.trackMaxAgeMinutes)) return false;
  return true;
}

const SNAP_SQL = `INSERT OR IGNORE INTO candidate_snapshots
  (lane, mint, t, symbol, dex_id, source, price, liquidity, fdv, vol_m5, vol_h1, vol_h6, vol_h24, buys_m5, sells_m5, buys_h1, sells_h1,
   buyers_h1, sellers_h1, chg_m5, chg_h1, chg_h6, chg_h24, age_min, score, verdict, reason)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function snapRow(db: D1Database, lane: Lane, now: number, s: MarketSnapshot, source: string, score: number | null, verdict: string, reason: string | null) {
  return db
    .prepare(SNAP_SQL)
    .bind(
      lane, s.mint, now, s.symbol, s.dexId, source, s.priceUsd, s.liquidityUsd, s.fdvUsd, s.volumeM5Usd, s.volumeH1Usd, s.volumeH6Usd ?? null, s.volumeH24Usd ?? null,
      s.txnsM5.buys, s.txnsM5.sells, s.txnsH1.buys, s.txnsH1.sells, s.buyersH1 ?? null, s.sellersH1 ?? null,
      s.priceChangeM5Pct, s.priceChangeH1Pct, s.priceChangeH6Pct ?? null, s.priceChangeH24Pct ?? null, s.ageMinutes, score, verdict, reason?.slice(0, 120) ?? null,
    );
}

/** All feature-store writes for one tick. */
export function buildFeatureWrites(
  db: D1Database,
  now: number,
  plan: SamplingPlan,
  lanes: { lane: Lane; cfg: Config; candidates: CandidateRow[] }[],
  snapshots: Map<string, MarketSnapshot>,
  risk: Record<string, RiskSummary>,
): D1PreparedStatement[] {
  const w: D1PreparedStatement[] = [];

  for (const [mint, r] of Object.entries(risk)) {
    w.push(
      db
        .prepare("INSERT OR REPLACE INTO token_risk (mint, fetched_at, score, score_normalised, lp_locked_pct, risks) VALUES (?,?,?,?,?,?)")
        .bind(mint, now, r.score, r.scoreNormalised, r.lpLockedPct, JSON.stringify(r.risks)),
    );
  }

  if (!plan.isSample) return w;

  for (const { lane, cfg, candidates } of lanes) {
    if (!plan.laneSample[lane]) continue; // this lane's cadence says not this tick
    const recorded = new Set<string>();
    for (const c of candidates) {
      if (!c.snap || !shouldTrack(c.snap, cfg) || recorded.has(c.mint)) continue;
      recorded.add(c.mint);
      w.push(
        snapRow(db, lane, now, c.snap, c.source, c.score, c.passed ? "pass" : "reject", c.passed ? null : c.reason),
        db
          .prepare("INSERT OR IGNORE INTO watchlist (lane, mint, first_seen, until) VALUES (?,?,?,?)")
          .bind(lane, c.mint, now, now + cfg.data.trackMinutes * 60_000),
      );
    }
    // Coins we are still tracking that weren't candidates this tick.
    for (const x of plan.watch) {
      if (x.lane !== lane || recorded.has(x.mint)) continue;
      const s = snapshots.get(x.mint);
      if (!s || s.priceUsd <= 0) continue;
      recorded.add(x.mint);
      w.push(snapRow(db, lane, now, s, "watchlist", null, "watch", null));
    }
  }

  const keep = (lanes[0]?.cfg.data.retentionDays ?? 7) * 86_400_000;
  w.push(
    db.prepare("DELETE FROM candidate_snapshots WHERE t < ?").bind(now - keep),
    db.prepare("DELETE FROM watchlist WHERE until < ?").bind(now - 86_400_000),
  );
  return w;
}
