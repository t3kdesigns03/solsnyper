import { CONFIG, type Config } from "./config";
import { discoverDexScreener, fetchSnapshots, fetchSolPrice } from "./sources/dexscreener";
import { discoverPumpFun } from "./sources/pumpfun";
import { planTick, type TickPlan } from "./strategy/decide";
import type { DiscoveredMint, Env, MarketSnapshot, OpenPosition } from "./types";

// One tick = discover -> fetch prices -> planTick (pure) -> persist.
// Sources are injectable so tests and local runs can use fixtures.

export interface Sources {
  discover(env: Env): Promise<{ mints: DiscoveredMint[]; errors: string[] }>;
  snapshots(mints: string[], now: number): Promise<Map<string, MarketSnapshot>>;
  solPrice(now: number): Promise<number | null>;
}

export const liveSources: Sources = {
  async discover(env) {
    const jobs: [string, () => Promise<DiscoveredMint[]>][] = [["dexscreener", discoverDexScreener]];
    if (env.ENABLE_PUMPFUN !== "false") jobs.push(["pumpfun", discoverPumpFun]);
    const res = await Promise.allSettled(jobs.map(([, fn]) => fn()));
    const mints: DiscoveredMint[] = [];
    const errors: string[] = [];
    res.forEach((r, i) => {
      if (r.status === "fulfilled") mints.push(...r.value);
      else errors.push(`${jobs[i][0]}: ${String(r.reason)}`);
    });
    return { mints, errors };
  },
  snapshots: fetchSnapshots,
  solPrice: fetchSolPrice,
};

export interface TickSummary {
  startedAt: number;
  durationMs: number;
  candidatesSeen: number;
  buys: number;
  sells: number;
  equityUsd: number;
  errors: string[];
}

export async function runTick(env: Env, now = Date.now(), sources: Sources = liveSources, cfg: Config = CONFIG): Promise<TickSummary> {
  const db = env.DB;
  const errors: string[] = [];

  // --- load state
  const wallet = await db.prepare("SELECT cash_usd, sol_price_usd FROM wallet WHERE id = 1").first<{ cash_usd: number; sol_price_usd: number }>();
  if (!wallet) throw new Error("wallet row missing: run the D1 migration");
  const open = (await db.prepare("SELECT * FROM positions WHERE status = 'open'").all<OpenPosition>()).results;
  const cooldownStart = now - cfg.filters.reentryCooldownMinutes * 60_000;
  const recent = (
    await db
      .prepare("SELECT mint, MAX(timestamp) AS t FROM trades WHERE timestamp > ? GROUP BY mint")
      .bind(cooldownStart)
      .all<{ mint: string; t: number }>()
  ).results;
  const recentlyTraded = new Map(recent.map((r) => [r.mint, r.t]));
  const prevReasons = new Map(
    (
      await db
        .prepare("SELECT mint, reject_reason FROM candidates WHERE last_seen > ?")
        .bind(now - cfg.retention.candidatesHours * 3_600_000)
        .all<{ mint: string; reject_reason: string | null }>()
    ).results.map((r) => [r.mint, r.reject_reason]),
  );

  // --- fetch market data
  const disc = await sources.discover(env);
  errors.push(...disc.errors);
  let snapshots = new Map<string, MarketSnapshot>();
  try {
    snapshots = await sources.snapshots([...open.map((p) => p.mint), ...disc.mints.map((d) => d.mint)], now);
  } catch (e) {
    errors.push(`snapshots: ${String(e)}`);
  }
  const solPrice = (await sources.solPrice(now)) ?? wallet.sol_price_usd;

  // --- decide (pure)
  const plan = planTick({ now, cfg, cashUsd: wallet.cash_usd, open, discovered: disc.mints, snapshots, recentlyTraded });

  // --- persist
  await db.batch(buildWrites(db, plan, now, solPrice, prevReasons, cfg, errors));

  return {
    startedAt: now,
    durationMs: Date.now() - now,
    candidatesSeen: plan.candidates.length,
    buys: plan.buys.length,
    sells: plan.sells.length,
    equityUsd: plan.equityAfter,
    errors,
  };
}

function buildWrites(
  db: D1Database,
  plan: TickPlan,
  now: number,
  solPrice: number,
  prevReasons: Map<string, string | null>,
  cfg: Config,
  errors: string[],
): D1PreparedStatement[] {
  const w: D1PreparedStatement[] = [];

  for (const s of plan.sells) {
    w.push(
      db
        .prepare(
          `UPDATE positions SET status='closed', current_price=?, exit_price=?, exit_time=?, realized_pnl=?, unrealized_pnl=0, close_reason=?, last_update=? WHERE id=?`,
        )
        .bind(s.price, s.price, now, s.pnlUsd, `${s.rule}: ${s.reason}`, now, s.pos.id),
      db
        .prepare(`INSERT INTO trades (position_id, mint, symbol, side, price, size_usd, fees_usd, pnl_usd, reason, timestamp) VALUES (?,?,?,'sell',?,?,?,?,?,?)`)
        .bind(s.pos.id, s.pos.mint, s.pos.symbol, s.price, s.cashIn + s.feeUsd, s.feeUsd, s.pnlUsd, `${s.rule}: ${s.reason}`, now),
    );
  }

  for (const u of plan.updates) {
    w.push(
      db
        .prepare(`UPDATE positions SET current_price=?, current_liquidity=?, peak_price=?, unrealized_pnl=?, missed_updates=?, last_update=? WHERE id=?`)
        .bind(u.price, u.liquidity, u.peak, u.unrealizedPnl, u.missedUpdates, now, u.id),
    );
  }

  for (const b of plan.buys) {
    const s = b.snap;
    w.push(
      db
        .prepare(
          `INSERT INTO positions (mint, symbol, pair_address, entry_price, entry_time, size_usd, quantity, entry_fee_usd, entry_liquidity, current_price, current_liquidity, peak_price, unrealized_pnl, last_update, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open')`,
        )
        .bind(s.mint, s.symbol, s.pairAddress, s.priceUsd, now, cfg.wallet.buySizeUsd, b.quantity, b.feeUsd, s.liquidityUsd, s.priceUsd, s.liquidityUsd, s.priceUsd, -b.feeUsd * 2, now),
      db
        .prepare(
          `INSERT INTO trades (position_id, mint, symbol, side, price, size_usd, fees_usd, pnl_usd, reason, timestamp)
           VALUES ((SELECT MAX(id) FROM positions WHERE mint=? AND status='open'),?,?,'buy',?,?,?,0,?,?)`,
        )
        .bind(s.mint, s.mint, s.symbol, s.priceUsd, cfg.wallet.buySizeUsd, b.feeUsd, `score ${b.score}`, now),
    );
  }

  for (const c of plan.candidates) {
    const s = c.snap;
    w.push(
      db
        .prepare(
          `INSERT INTO candidates (mint, symbol, source, pair_address, dex_id, liquidity, volume, age_minutes, price, flagged, reject_reason, score, first_seen, last_seen)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol, pair_address=excluded.pair_address, dex_id=excluded.dex_id,
             liquidity=excluded.liquidity, volume=excluded.volume, age_minutes=excluded.age_minutes, price=excluded.price,
             flagged=excluded.flagged, reject_reason=excluded.reject_reason, score=excluded.score, last_seen=excluded.last_seen`,
        )
        .bind(
          c.mint, c.symbol, c.source, s?.pairAddress ?? null, s?.dexId ?? null, s?.liquidityUsd ?? null, s?.volumeH1Usd ?? null,
          s?.ageMinutes ?? null, s?.priceUsd ?? null, c.passed ? 1 : 0, c.passed ? null : c.reason, c.score, now, now,
        ),
    );
  }

  for (const d of plan.decisions) {
    // Rejects are only re-logged when the reason changes, unless configured otherwise.
    if (d.action === "reject" && !cfg.retention.logUnchangedRejects && prevReasons.get(d.mint) === d.reason) continue;
    w.push(db.prepare(`INSERT INTO decisions (mint, action, reason, score, timestamp) VALUES (?,?,?,?,?)`).bind(d.mint, d.action, d.reason, d.score, now));
  }

  w.push(
    db
      .prepare(`UPDATE wallet SET cash_usd=?, cash_sol=?, equity_usd=?, sol_price_usd=?, updated_at=? WHERE id=1`)
      .bind(plan.cashAfter, solPrice > 0 ? plan.cashAfter / solPrice : 0, plan.equityAfter, solPrice, now),
    db.prepare(`INSERT OR REPLACE INTO equity_snapshots (timestamp, equity_usd, cash_usd, open_positions) VALUES (?,?,?,?)`).bind(now, plan.equityAfter, plan.cashAfter, plan.openAfter),
    db
      .prepare(`INSERT INTO runs (started_at, duration_ms, candidates_seen, buys, sells, errors) VALUES (?,?,?,?,?,?)`)
      .bind(now, Date.now() - now, plan.candidates.length, plan.buys.length, plan.sells.length, errors.length ? errors.join(" | ") : null),
    // retention
    db.prepare(`DELETE FROM decisions WHERE timestamp < ?`).bind(now - cfg.retention.decisionsDays * 86_400_000),
    db.prepare(`DELETE FROM candidates WHERE last_seen < ?`).bind(now - cfg.retention.candidatesHours * 3_600_000),
    db.prepare(`DELETE FROM runs WHERE started_at < ?`).bind(now - cfg.retention.decisionsDays * 86_400_000),
  );
  return w;
}
