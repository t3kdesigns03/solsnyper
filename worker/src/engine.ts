import { CONFIG, type Config, LANE_CONFIG, LANES, type Lane } from "./config";
import { discoverDexScreener, fetchSnapshots, fetchSolPrice } from "./sources/dexscreener";
import { discoverGeckoEstablished, discoverGeckoTerminal, fetchGeckoSnapshots } from "./sources/geckoterminal";
import { discoverPumpFun } from "./sources/pumpfun";
import { callRelay } from "./sources/relay";
import { fetchRiskSummaries, type RiskSummary } from "./sources/rugcheck";
import { buildFeatureWrites, planSampling } from "./featurestore";
import { planTick, type TickPlan } from "./strategy/decide";
import type { DiscoveredMint, Env, MarketSnapshot, OpenPosition, PendingOrder } from "./types";

// One tick = discover -> fetch prices -> planTick (pure) -> persist.
// Sources are injectable so tests and local runs can use fixtures.

export interface Sources {
  discover(env: Env): Promise<{ mints: DiscoveredMint[]; errors: string[] }>;
  snapshots(mints: string[], now: number, env?: Env): Promise<Map<string, MarketSnapshot>>;
  solPrice(now: number, env?: Env): Promise<number | null>;
  /** Optional: established pools (stable lane) with their snapshots. */
  established?(env: Env, now: number): Promise<{ mints: DiscoveredMint[]; snapshots: MarketSnapshot[]; errors: string[] }>;
  /** Optional one-shot fetch of discovery + prices (used for the Netlify relay). */
  market?(env: Env, held: string[], now: number, opts?: MarketOpts): Promise<MarketData>;
}

export interface MarketOpts {
  riskMints?: string[]; // mints to look up on RugCheck this tick (feature store)
}

export interface MarketData {
  mints: DiscoveredMint[]; // brand-new pools (sniper lane)
  established: DiscoveredMint[]; // established pools (stable lane)
  errors: string[];
  snapshots: Map<string, MarketSnapshot>;
  solPrice: number | null;
  risk: Record<string, RiskSummary>; // RugCheck summaries fetched this tick
}

/** The plain path: discover, then price everything, then SOL. */
async function fetchMarket(sources: Sources, env: Env, held: string[], now: number, opts: MarketOpts = {}): Promise<MarketData> {
  const disc = await sources.discover(env);
  const errors = [...disc.errors];
  let snapshots = new Map<string, MarketSnapshot>();
  try {
    snapshots = await sources.snapshots([...held, ...disc.mints.map((d) => d.mint)], now, env);
  } catch (e) {
    errors.push(`snapshots: ${String(e)}`);
  }
  let established: DiscoveredMint[] = [];
  if (sources.established) {
    const est = await sources.established(env, now);
    errors.push(...est.errors);
    established = est.mints;
    for (const sn of est.snapshots) if (!snapshots.has(sn.mint)) snapshots.set(sn.mint, sn);
  }
  let risk: Record<string, RiskSummary> = {};
  if (opts.riskMints?.length && sources === liveSources) {
    const rc = await fetchRiskSummaries(opts.riskMints);
    risk = rc.risk;
    errors.push(...rc.errors);
  }
  return { mints: disc.mints, established, errors, snapshots, solPrice: await sources.solPrice(now, env), risk };
}

const on = (v: string | undefined) => v !== "false";
const WSOL = "So11111111111111111111111111111111111111112";

async function discoverDirect(env: Env, includePumpFun: boolean) {
  const jobs: [string, () => Promise<DiscoveredMint[]>][] = [];
  if (on(env.ENABLE_GECKOTERMINAL)) jobs.push(["geckoterminal", discoverGeckoTerminal]);
  if (on(env.ENABLE_DEXSCREENER)) jobs.push(["dexscreener", discoverDexScreener]);
  if (includePumpFun && on(env.ENABLE_PUMPFUN)) jobs.push(["pumpfun", discoverPumpFun]);
  const res = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const mints: DiscoveredMint[] = [];
  const errors: string[] = [];
  res.forEach((r, i) => {
    if (r.status === "fulfilled") mints.push(...r.value);
    else errors.push(`${jobs[i][0]}: ${String(r.reason)}`);
  });
  return { mints, errors };
}

export const liveSources: Sources = {
  discover: (env) => discoverDirect(env, true),
  established: async (env, now) => (on(env.ENABLE_GECKOTERMINAL) ? discoverGeckoEstablished(now) : { mints: [], snapshots: [], errors: [] }),

  // Relay path: pump.fun direct (it works from Cloudflare), then ONE call to the
  // Netlify relay for GeckoTerminal/DexScreener discovery + prices. If the relay
  // is off, unconfigured or failing, fall back to direct calls.
  async market(env, held, now, opts = {}) {
    if (!on(env.ENABLE_RELAY) || !env.RELAY_URL || !env.RELAY_TOKEN) return fetchMarket(this, env, held, now, opts);
    const errors: string[] = [];
    let pump: DiscoveredMint[] = [];
    if (on(env.ENABLE_PUMPFUN)) {
      try {
        pump = await discoverPumpFun();
      } catch (e) {
        errors.push(`pumpfun: ${String(e)}`);
      }
    }
    try {
      const r = await callRelay(env.RELAY_URL, env.RELAY_TOKEN, [...held, ...pump.map((d) => d.mint)], {
        dexscreener: on(env.ENABLE_DEXSCREENER),
        riskMints: opts.riskMints,
      });
      return {
        mints: [...pump, ...r.discovered],
        established: r.established,
        errors: [...errors, ...r.errors.map((e) => `relay/${e}`)],
        snapshots: new Map(r.snapshots.map((s) => [s.mint, s])),
        solPrice: r.solPriceUsd,
        risk: r.risk ?? {},
      };
    } catch (e) {
      errors.push(`relay: ${String(e)} (fell back to direct calls)`);
      const direct = await fetchMarket({ ...this, discover: (en) => discoverDirect(en, false) }, env, held, now, opts);
      return { ...direct, mints: [...pump, ...direct.mints], errors: [...errors, ...direct.errors] };
    }
  },

  // GeckoTerminal is the primary price source; DexScreener only fills in mints
  // GeckoTerminal didn't return. Throws only if every enabled source failed.
  async snapshots(mints, now, env) {
    const out = new Map<string, MarketSnapshot>();
    const errors: string[] = [];
    if (on(env?.ENABLE_GECKOTERMINAL)) {
      try {
        for (const [k, v] of await fetchGeckoSnapshots(mints, now)) out.set(k, v);
      } catch (e) {
        errors.push(`geckoterminal: ${String(e)}`);
      }
    }
    const missing = [...new Set(mints)].filter((m) => !out.has(m));
    if (missing.length && on(env?.ENABLE_DEXSCREENER)) {
      try {
        for (const [k, v] of await fetchSnapshots(missing, now)) out.set(k, v);
      } catch (e) {
        errors.push(`dexscreener: ${String(e)}`);
      }
    }
    if (out.size === 0 && errors.length && mints.length) throw new Error(errors.join("; "));
    return out;
  },

  async solPrice(now, env) {
    if (on(env?.ENABLE_GECKOTERMINAL)) {
      try {
        const p = (await fetchGeckoSnapshots([WSOL], now)).get(WSOL)?.priceUsd;
        if (p) return p;
      } catch {
        /* fall through to DexScreener */
      }
    }
    return on(env?.ENABLE_DEXSCREENER) ? fetchSolPrice(now) : null;
  },
};

export interface LaneSummary {
  candidatesSeen: number;
  buys: number;
  sells: number;
  equityUsd: number;
}

/** Top-level fields are the sniper lane's (kept for older callers); `lanes` has both. */
export interface TickSummary extends LaneSummary {
  startedAt: number;
  durationMs: number;
  errors: string[];
  lanes: Record<Lane, LaneSummary>;
}

// ── Per-lane storage ─────────────────────────────────────────────────────────
// The sniper lane keeps the original single-row `wallet` table and
// `equity_snapshots`; other lanes use `lane_wallets` / `lane_equity`
// (migration 0004). Everything else is one table with a `lane` column.

async function readWallet(db: D1Database, lane: Lane): Promise<{ cash_usd: number; sol_price_usd: number }> {
  const sniper = await db.prepare("SELECT cash_usd, sol_price_usd FROM wallet WHERE id = 1").first<{ cash_usd: number; sol_price_usd: number }>();
  if (!sniper) throw new Error("wallet row missing: run the D1 migrations");
  if (lane === "sniper") return sniper;
  const w = await db.prepare("SELECT cash_usd FROM lane_wallets WHERE lane = ?").bind(lane).first<{ cash_usd: number }>();
  if (!w) throw new Error(`lane_wallets row for '${lane}' missing: run the D1 migrations`);
  return { cash_usd: w.cash_usd, sol_price_usd: sniper.sol_price_usd };
}

interface LaneState {
  lane: Lane;
  cfg: Config;
  cashUsd: number;
  open: OpenPosition[];
  pending: PendingOrder[];
  recentlyTraded: Map<string, number>;
  recentSymbols: Map<string, number>;
  buysLastHour: number;
}

async function loadLane(db: D1Database, lane: Lane, cfg: Config, now: number): Promise<LaneState & { solPrice: number }> {
  const wallet = await readWallet(db, lane);
  const open = (await db.prepare("SELECT * FROM positions WHERE status = 'open' AND lane = ?").bind(lane).all<OpenPosition>()).results;
  const pending = (await db.prepare("SELECT * FROM pending_orders WHERE lane = ? ORDER BY id").bind(lane).all<PendingOrder>()).results;
  const recent = (
    await db
      .prepare("SELECT mint, MAX(timestamp) AS t FROM trades WHERE lane = ? AND timestamp > ? GROUP BY mint")
      .bind(lane, now - cfg.filters.reentryCooldownMinutes * 60_000)
      .all<{ mint: string; t: number }>()
  ).results;
  // Cost control: symbols bought recently (relaunch check) and the rolling-hour buy count.
  const symWindow = Math.max(1, cfg.costControl.symbolCooldownMinutes) * 60_000;
  const symbols = (
    await db
      .prepare("SELECT UPPER(symbol) AS s, MAX(timestamp) AS t FROM trades WHERE lane = ? AND side='buy' AND timestamp > ? GROUP BY UPPER(symbol)")
      .bind(lane, now - symWindow)
      .all<{ s: string; t: number }>()
  ).results;
  const buysLastHour =
    (await db.prepare("SELECT COUNT(*) AS n FROM trades WHERE lane = ? AND side='buy' AND timestamp > ?").bind(lane, now - 3_600_000).first<{ n: number }>())?.n ?? 0;
  return {
    lane, cfg, cashUsd: wallet.cash_usd, solPrice: wallet.sol_price_usd, open, pending,
    recentlyTraded: new Map(recent.map((r) => [r.mint, r.t])),
    recentSymbols: new Map(symbols.map((r) => [r.s, r.t])),
    buysLastHour,
  };
}

export async function runTick(
  env: Env,
  now = Date.now(),
  sources: Sources = liveSources,
  lanes: Partial<Record<Lane, Config>> = LANE_CONFIG,
): Promise<TickSummary> {
  const db = env.DB;
  const errors: string[] = [];
  const active = LANES.filter((l) => lanes[l]);

  // --- load state for every lane
  const states = await Promise.all(active.map((l) => loadLane(db, l, lanes[l]!, now)));
  const retention = (lanes.sniper ?? CONFIG).retention;
  const prevCandidates = new Map(
    (
      await db
        .prepare("SELECT mint, lane, reject_reason, flagged, price, liquidity, last_seen FROM candidates WHERE last_seen > ?")
        .bind(now - retention.candidatesHours * 3_600_000)
        .all<PrevCandidate>()
    ).results.map((r) => [r.mint, r]),
  );

  // --- feature store: is this a sample tick, which tracked coins to price, which need a risk lookup
  const sampling = await planSampling(db, lanes.sniper ?? CONFIG, now);

  // --- ONE market fetch for all lanes (mints with a pending buy count as held, so they get priced)
  const held = [
    ...new Set([
      ...states.flatMap((s) => [...s.open.map((p) => p.mint), ...s.pending.filter((o) => o.side === "buy").map((o) => o.mint)]),
      ...sampling.watch.map((x) => x.mint),
    ]),
  ];
  const opts = { riskMints: sampling.riskMints };
  const market = sources.market ? await sources.market(env, held, now, opts) : await fetchMarket(sources, env, held, now, opts);
  errors.push(...market.errors);
  // SOL price: live, else last stored; planTick falls back to CONFIG if both are 0.
  const solPrice = market.solPrice ?? states[0]?.solPrice ?? 0;

  // --- decide (pure) per lane, then persist everything in one batch
  const writes: D1PreparedStatement[] = [];
  const summaries = {} as Record<Lane, LaneSummary>;
  const laneCandidates: Parameters<typeof buildFeatureWrites>[3] = [];
  for (const st of states) {
    const plan = planTick({
      now, cfg: st.cfg, cashUsd: st.cashUsd, solPriceUsd: solPrice, open: st.open, pending: st.pending,
      discovered: st.lane === "stable" ? market.established : market.mints,
      snapshots: market.snapshots, recentlyTraded: st.recentlyTraded, recentSymbols: st.recentSymbols, buysLastHour: st.buysLastHour,
    });
    writes.push(...buildWrites(db, st.lane, plan, now, solPrice, prevCandidates, st.cfg, errors));
    summaries[st.lane] = { candidatesSeen: plan.candidates.length, buys: plan.buys.length, sells: plan.sells.length, equityUsd: plan.equityAfter };
    laneCandidates.push({ lane: st.lane, cfg: st.cfg, candidates: plan.candidates });
  }
  writes.push(...buildFeatureWrites(db, now, sampling, laneCandidates, market.snapshots, market.risk ?? {}));
  writes.push(
    db.prepare(`DELETE FROM decisions WHERE timestamp < ?`).bind(now - retention.decisionsDays * 86_400_000),
    db.prepare(`DELETE FROM candidates WHERE last_seen < ?`).bind(now - retention.candidatesHours * 3_600_000),
    db.prepare(`DELETE FROM runs WHERE started_at < ?`).bind(now - retention.decisionsDays * 86_400_000),
  );
  await db.batch(writes);

  const sniper = summaries.sniper ?? { candidatesSeen: 0, buys: 0, sells: 0, equityUsd: 0 };
  return { startedAt: now, durationMs: Date.now() - now, ...sniper, errors, lanes: summaries };
}

interface PrevCandidate {
  mint: string;
  lane: string;
  reject_reason: string | null;
  flagged: number;
  price: number | null;
  liquidity: number | null;
  last_seen: number;
}

/**
 * Write reduction: a candidate row is re-saved only if it is new, its verdict
 * changed, price or liquidity moved by retention.candidateChangePct, or it
 * hasn't been refreshed for retention.candidateRefreshMinutes (keeps last_seen
 * fresh enough for the feed and the 6h retention window).
 */
function candidateChanged(prev: PrevCandidate | undefined, c: TickPlan["candidates"][number], lane: Lane, now: number, cfg: Config): boolean {
  if (!prev || prev.lane !== lane) return true;
  const reason = c.passed ? null : c.reason;
  if (prev.reject_reason !== reason || prev.flagged !== (c.passed ? 1 : 0)) return true;
  if (now - prev.last_seen >= cfg.retention.candidateRefreshMinutes * 60_000) return true;
  const moved = (a: number | null | undefined, b: number | null | undefined) =>
    (a ?? 0) === 0 ? (b ?? 0) !== 0 : Math.abs((b ?? 0) / (a as number) - 1) >= cfg.retention.candidateChangePct;
  return moved(prev.price, c.snap?.priceUsd) || moved(prev.liquidity, c.snap?.liquidityUsd);
}

function buildWrites(
  db: D1Database,
  lane: Lane,
  plan: TickPlan,
  now: number,
  solPrice: number,
  prevCandidates: Map<string, PrevCandidate>,
  cfg: Config,
  errors: string[],
): D1PreparedStatement[] {
  const w: D1PreparedStatement[] = [];

  // entry_price / exit_price are FILL prices (after slippage); *_signal_price is
  // what we observed when the decision was made. fees_usd = DEX + network fees.
  for (const s of plan.sells) {
    const f = s.fill;
    const reason = `${s.rule}: ${s.reason}`;
    w.push(
      db
        .prepare(
          `UPDATE positions SET status='closed', current_price=?, exit_price=?, exit_signal_price=?, exit_time=?, realized_pnl=?, unrealized_pnl=0,
             exit_dex_fee_usd=?, exit_network_fee_usd=?, exit_slippage_usd=?, close_reason=?, last_update=? WHERE id=?`,
        )
        .bind(f.signalPrice, f.fillPrice, s.signalPrice, now, f.pnlUsd, f.costs.dexFeeUsd, f.costs.networkFeeUsd, f.costs.slippageUsd, reason, now, s.pos.id),
      db
        .prepare(
          `INSERT INTO trades (lane, position_id, mint, symbol, side, price, signal_price, size_usd, fees_usd, dex_fee_usd, network_fee_usd, slippage_usd, pnl_usd, reason, timestamp)
           VALUES (?,?,?,?,'sell',?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          lane, s.pos.id, s.pos.mint, s.pos.symbol, f.fillPrice, s.signalPrice, f.receivedUsd, f.costs.dexFeeUsd + f.costs.networkFeeUsd,
          f.costs.dexFeeUsd, f.costs.networkFeeUsd, f.costs.slippageUsd, f.pnlUsd, reason, now,
        ),
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
    const f = b.fill;
    const size = b.sizeUsd;
    // entry_fee_usd = cash spent beyond size_usd (the network fee). The DEX fee
    // and slippage are already "inside" the smaller token quantity.
    w.push(
      db
        .prepare(
          `INSERT INTO positions (lane, mint, symbol, pair_address, dex_id, entry_price, entry_signal_price, entry_time, size_usd, quantity, entry_fee_usd,
             entry_dex_fee_usd, entry_network_fee_usd, entry_slippage_usd, entry_liquidity, current_price, current_liquidity, peak_price, unrealized_pnl, last_update, status,
             entry_score, entry_signal_liquidity, entry_age_minutes, entry_fdv_usd, entry_volume_h1_usd, entry_buys_h1, entry_sells_h1, entry_change_m5_pct, entry_change_h1_pct)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          lane, s.mint, s.symbol, s.pairAddress, s.dexId, f.fillPrice, b.signalPrice, now, size, f.quantity, f.cashOut - size,
          f.costs.dexFeeUsd, f.costs.networkFeeUsd, f.costs.slippageUsd, s.liquidityUsd, s.priceUsd, s.liquidityUsd, f.fillPrice, -f.costs.totalUsd, now,
          b.score, b.signalLiquidity, s.ageMinutes, s.fdvUsd, s.volumeH1Usd, s.txnsH1.buys, s.txnsH1.sells, s.priceChangeM5Pct, s.priceChangeH1Pct,
        ),
      db
        .prepare(
          `INSERT INTO trades (lane, position_id, mint, symbol, side, price, signal_price, size_usd, fees_usd, dex_fee_usd, network_fee_usd, slippage_usd, pnl_usd, reason, timestamp)
           VALUES (?,(SELECT MAX(id) FROM positions WHERE mint=? AND status='open' AND lane=?),?,?,'buy',?,?,?,?,?,?,?,0,?,?)`,
        )
        .bind(
          lane, s.mint, lane, s.mint, s.symbol, f.fillPrice, b.signalPrice, size, f.costs.dexFeeUsd + f.costs.networkFeeUsd,
          f.costs.dexFeeUsd, f.costs.networkFeeUsd, f.costs.slippageUsd, b.reason, now,
        ),
    );
  }

  // Pending orders: drop filled/cancelled, bump waiting, add new.
  for (const o of plan.closedOrders) w.push(db.prepare(`DELETE FROM pending_orders WHERE id=?`).bind(o.id));
  for (const o of plan.waitingOrders) w.push(db.prepare(`UPDATE pending_orders SET ticks_waited=? WHERE id=?`).bind(o.ticksWaited, o.id));
  for (const o of plan.newOrders) {
    w.push(
      db
        .prepare(
          `INSERT INTO pending_orders (lane, side, mint, symbol, position_id, signal_price, signal_time, reason, score, ticks_waited, signal_liquidity) VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
        )
        .bind(lane, o.side, o.mint, o.symbol, o.position_id, o.signal_price, o.signal_time, o.reason, o.score, o.signal_liquidity),
    );
  }

  for (const c of plan.candidates) {
    const s = c.snap;
    if (!candidateChanged(prevCandidates.get(c.mint), c, lane, now, cfg)) continue; // nothing new: skip the write
    w.push(
      db
        .prepare(
          `INSERT INTO candidates (lane, mint, symbol, source, pair_address, dex_id, liquidity, volume, age_minutes, price, flagged, reject_reason, score, first_seen, last_seen)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(mint) DO UPDATE SET lane=excluded.lane, symbol=excluded.symbol, source=excluded.source, pair_address=excluded.pair_address, dex_id=excluded.dex_id,
             liquidity=excluded.liquidity, volume=excluded.volume, age_minutes=excluded.age_minutes, price=excluded.price,
             flagged=excluded.flagged, reject_reason=excluded.reject_reason, score=excluded.score, last_seen=excluded.last_seen`,
        )
        .bind(
          lane, c.mint, c.symbol, c.source, s?.pairAddress ?? null, s?.dexId ?? null, s?.liquidityUsd ?? null, s?.volumeH1Usd ?? null,
          s?.ageMinutes ?? null, s?.priceUsd ?? null, c.passed ? 1 : 0, c.passed ? null : c.reason, c.score, now, now,
        ),
    );
  }

  for (const d of plan.decisions) {
    // Rejects are only re-logged when the reason changes, unless configured otherwise.
    if (d.action === "reject" && !cfg.retention.logUnchangedRejects && prevCandidates.get(d.mint)?.reject_reason === d.reason) continue;
    w.push(db.prepare(`INSERT INTO decisions (lane, mint, action, reason, score, timestamp) VALUES (?,?,?,?,?,?)`).bind(lane, d.mint, d.action, d.reason, d.score, now));
  }

  if (lane === "sniper") {
    w.push(
      db
        .prepare(`UPDATE wallet SET cash_usd=?, cash_sol=?, equity_usd=?, sol_price_usd=?, updated_at=? WHERE id=1`)
        .bind(plan.cashAfter, solPrice > 0 ? plan.cashAfter / solPrice : 0, plan.equityAfter, solPrice, now),
      db.prepare(`INSERT OR REPLACE INTO equity_snapshots (timestamp, equity_usd, cash_usd, open_positions) VALUES (?,?,?,?)`).bind(now, plan.equityAfter, plan.cashAfter, plan.openAfter),
    );
  } else {
    w.push(
      db.prepare(`UPDATE lane_wallets SET cash_usd=?, equity_usd=?, updated_at=? WHERE lane=?`).bind(plan.cashAfter, plan.equityAfter, now, lane),
      db
        .prepare(`INSERT OR REPLACE INTO lane_equity (lane, timestamp, equity_usd, cash_usd, open_positions) VALUES (?,?,?,?,?)`)
        .bind(lane, now, plan.equityAfter, plan.cashAfter, plan.openAfter),
    );
  }
  w.push(
    db
      .prepare(`INSERT INTO runs (lane, started_at, duration_ms, candidates_seen, buys, sells, errors) VALUES (?,?,?,?,?,?,?)`)
      .bind(lane, now, Date.now() - now, plan.candidates.length, plan.buys.length, plan.sells.length, errors.length ? errors.join(" | ") : null),
  );
  return w;
}
