import { CONFIG, type Config } from "./config";
import { discoverDexScreener, fetchSnapshots, fetchSolPrice } from "./sources/dexscreener";
import { discoverGeckoTerminal, fetchGeckoSnapshots } from "./sources/geckoterminal";
import { discoverPumpFun } from "./sources/pumpfun";
import { callRelay } from "./sources/relay";
import { planTick, type TickPlan } from "./strategy/decide";
import type { DiscoveredMint, Env, MarketSnapshot, OpenPosition, PendingOrder } from "./types";

// One tick = discover -> fetch prices -> planTick (pure) -> persist.
// Sources are injectable so tests and local runs can use fixtures.

export interface Sources {
  discover(env: Env): Promise<{ mints: DiscoveredMint[]; errors: string[] }>;
  snapshots(mints: string[], now: number, env?: Env): Promise<Map<string, MarketSnapshot>>;
  solPrice(now: number, env?: Env): Promise<number | null>;
  /** Optional one-shot fetch of discovery + prices (used for the Netlify relay). */
  market?(env: Env, held: string[], now: number): Promise<MarketData>;
}

export interface MarketData {
  mints: DiscoveredMint[];
  errors: string[];
  snapshots: Map<string, MarketSnapshot>;
  solPrice: number | null;
}

/** The plain path: discover, then price everything, then SOL. */
async function fetchMarket(sources: Sources, env: Env, held: string[], now: number): Promise<MarketData> {
  const disc = await sources.discover(env);
  const errors = [...disc.errors];
  let snapshots = new Map<string, MarketSnapshot>();
  try {
    snapshots = await sources.snapshots([...held, ...disc.mints.map((d) => d.mint)], now, env);
  } catch (e) {
    errors.push(`snapshots: ${String(e)}`);
  }
  return { mints: disc.mints, errors, snapshots, solPrice: await sources.solPrice(now, env) };
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

  // Relay path: pump.fun direct (it works from Cloudflare), then ONE call to the
  // Netlify relay for GeckoTerminal/DexScreener discovery + prices. If the relay
  // is off, unconfigured or failing, fall back to direct calls.
  async market(env, held, now) {
    if (!on(env.ENABLE_RELAY) || !env.RELAY_URL || !env.RELAY_TOKEN) return fetchMarket(this, env, held, now);
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
      });
      return {
        mints: [...pump, ...r.discovered],
        errors: [...errors, ...r.errors.map((e) => `relay/${e}`)],
        snapshots: new Map(r.snapshots.map((s) => [s.mint, s])),
        solPrice: r.solPriceUsd,
      };
    } catch (e) {
      errors.push(`relay: ${String(e)} (fell back to direct calls)`);
      const direct = await fetchMarket({ ...this, discover: (en) => discoverDirect(en, false) }, env, held, now);
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
  if (!wallet) throw new Error("wallet row missing: run the D1 migrations");
  const open = (await db.prepare("SELECT * FROM positions WHERE status = 'open'").all<OpenPosition>()).results;
  const pending = (await db.prepare("SELECT * FROM pending_orders ORDER BY id").all<PendingOrder>()).results;
  const cooldownStart = now - cfg.filters.reentryCooldownMinutes * 60_000;
  const recent = (
    await db
      .prepare("SELECT mint, MAX(timestamp) AS t FROM trades WHERE timestamp > ? GROUP BY mint")
      .bind(cooldownStart)
      .all<{ mint: string; t: number }>()
  ).results;
  const recentlyTraded = new Map(recent.map((r) => [r.mint, r.t]));
  // Cost control: symbols bought recently (relaunch check) and the rolling-hour buy count.
  const symWindow = Math.max(1, cfg.costControl.symbolCooldownMinutes) * 60_000;
  const recentSymbols = new Map(
    (
      await db
        .prepare("SELECT UPPER(symbol) AS s, MAX(timestamp) AS t FROM trades WHERE side='buy' AND timestamp > ? GROUP BY UPPER(symbol)")
        .bind(now - symWindow)
        .all<{ s: string; t: number }>()
    ).results.map((r) => [r.s, r.t]),
  );
  const buysLastHour =
    (await db.prepare("SELECT COUNT(*) AS n FROM trades WHERE side='buy' AND timestamp > ?").bind(now - 3_600_000).first<{ n: number }>())?.n ?? 0;
  const prevReasons = new Map(
    (
      await db
        .prepare("SELECT mint, reject_reason FROM candidates WHERE last_seen > ?")
        .bind(now - cfg.retention.candidatesHours * 3_600_000)
        .all<{ mint: string; reject_reason: string | null }>()
    ).results.map((r) => [r.mint, r.reject_reason]),
  );

  // --- fetch market data (mints with a pending buy count as held, so they get priced)
  const held = [...open.map((p) => p.mint), ...pending.filter((o) => o.side === "buy").map((o) => o.mint)];
  const market = sources.market ? await sources.market(env, held, now) : await fetchMarket(sources, env, held, now);
  errors.push(...market.errors);
  // SOL price: live, else last stored; planTick falls back to CONFIG if both are 0.
  const solPrice = market.solPrice ?? wallet.sol_price_usd;

  // --- decide (pure)
  const plan = planTick({
    now, cfg, cashUsd: wallet.cash_usd, solPriceUsd: solPrice, open, pending,
    discovered: market.mints, snapshots: market.snapshots, recentlyTraded, recentSymbols, buysLastHour,
  });

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
          `INSERT INTO trades (position_id, mint, symbol, side, price, signal_price, size_usd, fees_usd, dex_fee_usd, network_fee_usd, slippage_usd, pnl_usd, reason, timestamp)
           VALUES (?,?,?,'sell',?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          s.pos.id, s.pos.mint, s.pos.symbol, f.fillPrice, s.signalPrice, f.receivedUsd, f.costs.dexFeeUsd + f.costs.networkFeeUsd,
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

  const size = cfg.wallet.buySizeUsd;
  for (const b of plan.buys) {
    const s = b.snap;
    const f = b.fill;
    // entry_fee_usd = cash spent beyond size_usd (the network fee). The DEX fee
    // and slippage are already "inside" the smaller token quantity.
    w.push(
      db
        .prepare(
          `INSERT INTO positions (mint, symbol, pair_address, dex_id, entry_price, entry_signal_price, entry_time, size_usd, quantity, entry_fee_usd,
             entry_dex_fee_usd, entry_network_fee_usd, entry_slippage_usd, entry_liquidity, current_price, current_liquidity, peak_price, unrealized_pnl, last_update, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open')`,
        )
        .bind(
          s.mint, s.symbol, s.pairAddress, s.dexId, f.fillPrice, b.signalPrice, now, size, f.quantity, f.cashOut - size,
          f.costs.dexFeeUsd, f.costs.networkFeeUsd, f.costs.slippageUsd, s.liquidityUsd, s.priceUsd, s.liquidityUsd, f.fillPrice, -f.costs.totalUsd, now,
        ),
      db
        .prepare(
          `INSERT INTO trades (position_id, mint, symbol, side, price, signal_price, size_usd, fees_usd, dex_fee_usd, network_fee_usd, slippage_usd, pnl_usd, reason, timestamp)
           VALUES ((SELECT MAX(id) FROM positions WHERE mint=? AND status='open'),?,?,'buy',?,?,?,?,?,?,?,0,?,?)`,
        )
        .bind(
          s.mint, s.mint, s.symbol, f.fillPrice, b.signalPrice, size, f.costs.dexFeeUsd + f.costs.networkFeeUsd,
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
        .prepare(`INSERT INTO pending_orders (side, mint, symbol, position_id, signal_price, signal_time, reason, score, ticks_waited) VALUES (?,?,?,?,?,?,?,?,0)`)
        .bind(o.side, o.mint, o.symbol, o.position_id, o.signal_price, o.signal_time, o.reason, o.score),
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
