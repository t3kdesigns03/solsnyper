import { isLane, type Lane, LANE_CONFIG, LANES } from "./config";
import { LEGACY_ROUND_TRIP_PCT, roundTripCost } from "./strategy/broker";
import { schedulerStub } from "./stub";
import type { Env } from "./types";

// Read-only JSON API for the dashboard, plus a few admin actions.
// Every GET takes ?lane=sniper|stable (default sniper).
//   GET  /api/lanes        side-by-side stats for every lane
//   GET  /api/summary      wallet, PnL, counts, scheduler + last run
//   GET  /api/candidates   latest candidate feed with pass/fail reasons
//   GET  /api/positions    open positions
//   GET  /api/orders       pending orders (decided, not yet filled)
//   GET  /api/trades       closed trades (sell legs) + buys
//   GET  /api/decisions    decision log
//   GET  /api/equity       equity curve (downsampled)
//   POST /api/run          run one tick now          (Bearer ADMIN_TOKEN)
//   POST /api/pause|resume pause / resume ticking    (Bearer ADMIN_TOKEN)
//   POST /api/reset        {lane, startingEquity}: wipe that lane, restart, keep ticking (Bearer ADMIN_TOKEN)

/**
 * CORS origin to send back. ALLOWED_ORIGIN is "*" or a comma-separated
 * allowlist; a listed request Origin is echoed back (browsers accept only one
 * origin per response). Unlisted origins get the first entry, which the
 * browser then rejects.
 */
export function corsOrigin(allowed: string | undefined, requestOrigin: string | null): string {
  const list = (allowed || "*").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (list.length === 0 || list.includes("*")) return "*";
  const origin = requestOrigin?.replace(/\/$/, "") ?? "";
  return list.includes(origin) ? origin : list[0];
}

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const cors = {
    "access-control-allow-origin": corsOrigin(env.ALLOWED_ORIGIN, req.headers.get("origin")),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    vary: "Origin",
  };
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
  const db = env.DB;
  const laneParam = url.searchParams.get("lane") ?? "sniper";
  if (!isLane(laneParam)) return json({ error: `unknown lane '${laneParam}' (use ${LANES.join(" or ")})` }, 400);
  const lane: Lane = laneParam;
  const cfg = LANE_CONFIG[lane];

  try {
    if (req.method === "GET") {
      switch (url.pathname) {
        case "/":
        case "/api":
          return json({ ok: true, simulated: true, name: "solsnyper paper-trading worker", lanes: LANES });

        case "/api/lanes":
          return json(await Promise.all(LANES.map(async (l) => ({ lane: l, ...(await laneStats(db, l)) }))));

        case "/api/summary": {
          const stats = await laneStats(db, lane);
          const pendingOrders = (await db.prepare("SELECT COUNT(*) AS n FROM pending_orders WHERE lane=?").bind(lane).first<{ n: number }>())?.n ?? 0;
          const lastRun = await db.prepare("SELECT * FROM runs WHERE lane=? ORDER BY id DESC LIMIT 1").bind(lane).first();
          let scheduler: unknown = null;
          try {
            scheduler = await (await schedulerStub(env).fetch("https://do/status")).json();
          } catch {
            /* DO unavailable in some local setups */
          }
          return json({
            simulated: true,
            lane,
            ...stats,
            totalFees: stats.costs.totalUsd,
            pendingOrders,
            costExamples: costExamples(lane, stats.wallet.sol_price_usd || cfg.costs.fallbackSolPriceUsd),
            lastRun,
            scheduler,
            config: cfg,
          });
        }

        case "/api/candidates":
          return json(
            (await db.prepare("SELECT * FROM candidates WHERE lane=? ORDER BY last_seen DESC, flagged DESC, score DESC LIMIT ?").bind(lane, limit).all()).results,
          );

        case "/api/orders":
          return json((await db.prepare("SELECT * FROM pending_orders WHERE lane=? ORDER BY id DESC").bind(lane).all()).results);

        case "/api/positions":
          return json((await db.prepare("SELECT * FROM positions WHERE status='open' AND lane=? ORDER BY entry_time DESC").bind(lane).all()).results);

        case "/api/closed":
          return json((await db.prepare("SELECT * FROM positions WHERE status='closed' AND lane=? ORDER BY exit_time DESC LIMIT ?").bind(lane, limit).all()).results);

        case "/api/trades":
          return json((await db.prepare("SELECT * FROM trades WHERE lane=? ORDER BY timestamp DESC, id DESC LIMIT ?").bind(lane, limit).all()).results);

        case "/api/decisions": {
          const action = url.searchParams.get("action");
          const stmt = action
            ? db.prepare("SELECT * FROM decisions WHERE lane=? AND action=? ORDER BY id DESC LIMIT ?").bind(lane, action, limit)
            : db.prepare("SELECT * FROM decisions WHERE lane=? ORDER BY id DESC LIMIT ?").bind(lane, limit);
          return json((await stmt.all()).results);
        }

        case "/api/equity": {
          const hours = Math.min(24 * 30, Math.max(1, parseInt(url.searchParams.get("hours") ?? "24", 10) || 24));
          const since = Date.now() - hours * 3_600_000;
          // bucket so we return at most ~300 points
          const bucket = Math.max(45_000, Math.ceil((hours * 3_600_000) / 300));
          const rows =
            lane === "sniper"
              ? await db
                  .prepare(
                    "SELECT (timestamp / ?) * ? AS t, AVG(equity_usd) AS equity, AVG(cash_usd) AS cash FROM equity_snapshots WHERE timestamp > ? GROUP BY timestamp / ? ORDER BY t",
                  )
                  .bind(bucket, bucket, since, bucket)
                  .all()
              : await db
                  .prepare(
                    "SELECT (timestamp / ?) * ? AS t, AVG(equity_usd) AS equity, AVG(cash_usd) AS cash FROM lane_equity WHERE lane = ? AND timestamp > ? GROUP BY timestamp / ? ORDER BY t",
                  )
                  .bind(bucket, bucket, lane, since, bucket)
                  .all();
          return json(rows.results);
        }
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: "unauthorized (set ADMIN_TOKEN secret and send Authorization: Bearer <token>)" }, 401);
      }
      const stub = schedulerStub(env);
      switch (url.pathname) {
        case "/api/run":
          return json(await (await stub.fetch("https://do/run-now")).json());
        case "/api/pause":
          return json(await (await stub.fetch("https://do/pause")).json());
        case "/api/resume":
          return json(await (await stub.fetch("https://do/resume")).json());
        case "/api/reset": {
          // JSON body {lane?: "sniper" | "stable" (default "sniper"), startingEquity?: 100 .. 1,000,000}.
          // Wipes that lane's history (cannot be undone) and keeps the 45s loop running.
          const body = (await req.json().catch(() => null)) as { lane?: unknown; startingEquity?: unknown } | null;
          const target = body?.lane ?? url.searchParams.get("lane") ?? "sniper";
          if (!isLane(target)) return json({ error: `unknown lane '${String(target)}' (use ${LANES.join(" or ")})` }, 400);
          let start = LANE_CONFIG[target].wallet.startingEquityUsd;
          if (body && body.startingEquity !== undefined) {
            const n = Number(body.startingEquity);
            if (!Number.isFinite(n) || n < 100 || n > 1_000_000) {
              return json({ error: "startingEquity must be a number from 100 to 1,000,000" }, 400);
            }
            start = Math.round(n * 100) / 100;
          }
          const now = Date.now();
          await db.batch([
            db.prepare("DELETE FROM positions WHERE lane=?").bind(target),
            db.prepare("DELETE FROM trades WHERE lane=?").bind(target),
            db.prepare("DELETE FROM candidates WHERE lane=?").bind(target),
            db.prepare("DELETE FROM decisions WHERE lane=?").bind(target),
            db.prepare("DELETE FROM runs WHERE lane=?").bind(target),
            db.prepare("DELETE FROM pending_orders WHERE lane=?").bind(target),
            ...(target === "sniper"
              ? [
                  db.prepare("DELETE FROM equity_snapshots"),
                  db.prepare("UPDATE wallet SET cash_usd=?, cash_sol=0, equity_usd=?, starting_equity=?, updated_at=? WHERE id=1").bind(start, start, start, now),
                ]
              : [
                  db.prepare("DELETE FROM lane_equity WHERE lane=?").bind(target),
                  db
                    .prepare(
                      "INSERT INTO lane_wallets (lane, cash_usd, equity_usd, starting_equity, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(lane) DO UPDATE SET cash_usd=excluded.cash_usd, equity_usd=excluded.equity_usd, starting_equity=excluded.starting_equity, updated_at=excluded.updated_at",
                    )
                    .bind(target, start, start, start, now),
                ]),
          ]);
          // Make sure tracking continues: unpause and arm the alarm (first tick in ~1s).
          const scheduler = (await (await stub.fetch("https://do/resume")).json()) as { paused: boolean };
          return json({ reset: true, lane: target, startingEquity: start, paused: scheduler.paused });
        }
      }
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

interface WalletView {
  cash_usd: number;
  cash_sol: number;
  equity_usd: number;
  starting_equity: number;
  sol_price_usd: number;
  updated_at: number;
}

/** Wallet + P&L + cost totals for one lane (same shape for every lane). */
async function laneStats(db: D1Database, lane: Lane) {
  const sniper = await db.prepare("SELECT * FROM wallet WHERE id=1").first<WalletView>();
  const sol = sniper?.sol_price_usd ?? 0;
  let wallet: WalletView;
  if (lane === "sniper") wallet = sniper!;
  else {
    const w = await db.prepare("SELECT * FROM lane_wallets WHERE lane=?").bind(lane).first<{ cash_usd: number; equity_usd: number; starting_equity: number; updated_at: number }>();
    wallet = {
      cash_usd: w?.cash_usd ?? 0,
      cash_sol: sol > 0 ? (w?.cash_usd ?? 0) / sol : 0,
      equity_usd: w?.equity_usd ?? 0,
      starting_equity: w?.starting_equity ?? 0,
      sol_price_usd: sol,
      updated_at: w?.updated_at ?? 0,
    };
  }
  const realized = await db
    .prepare("SELECT COALESCE(SUM(pnl_usd),0) AS pnl, COUNT(*) AS n, SUM(CASE WHEN pnl_usd>0 THEN 1 ELSE 0 END) AS wins FROM trades WHERE side='sell' AND lane=?")
    .bind(lane)
    .first<{ pnl: number; n: number; wins: number }>();
  const c = await db
    .prepare("SELECT COALESCE(SUM(dex_fee_usd),0) AS dex, COALESCE(SUM(network_fee_usd),0) AS net, COALESCE(SUM(slippage_usd),0) AS slip FROM trades WHERE lane=?")
    .bind(lane)
    .first<{ dex: number; net: number; slip: number }>();
  const openAgg = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(unrealized_pnl),0) AS u, COALESCE(SUM(size_usd),0) AS exposure FROM positions WHERE status='open' AND lane=?")
    .bind(lane)
    .first<{ n: number; u: number; exposure: number }>();
  const dex = c?.dex ?? 0, net = c?.net ?? 0, slip = c?.slip ?? 0;
  return {
    wallet,
    realizedPnl: realized?.pnl ?? 0,
    closedTrades: realized?.n ?? 0,
    wins: realized?.wins ?? 0,
    costs: { dexFeesUsd: dex, networkFeesUsd: net, slippageUsd: slip, totalUsd: dex + net + slip },
    openPositions: openAgg?.n ?? 0,
    unrealizedPnl: openAgg?.u ?? 0,
    exposureUsd: openAgg?.exposure ?? 0,
  };
}

/**
 * What a buy + immediate sell at an unchanged price costs with the lane's
 * settings, for a few typical pools. Shown on the dashboard so the cost of a
 * round trip is visible before tuning take-profit / stop levels.
 */
function costExamples(lane: Lane, solPriceUsd: number) {
  const cfg = LANE_CONFIG[lane];
  const size = cfg.wallet.buySizeUsd;
  const pools: [string, string, number][] =
    lane === "stable"
      ? [
          ["PumpSwap, $150k", "pumpswap", 150_000],
          ["Raydium, $150k", "raydium", 150_000],
          ["Meteora, $300k", "meteora", 300_000],
          ["Raydium, $1M", "raydium", 1_000_000],
        ]
      : [
          ["pump.fun curve, $25k", "pumpfun", 25_000],
          ["PumpSwap, $25k", "pumpswap", 25_000],
          ["Raydium, $25k", "raydium", 25_000],
          ["Raydium, $250k", "raydium", 250_000],
        ];
  return {
    sizeUsd: size,
    solPriceUsd,
    legacyFlatUsd: size * LEGACY_ROUND_TRIP_PCT,
    rows: pools.map(([label, dexId, liquidityUsd]) => ({ label, dexId, liquidityUsd, ...roundTripCost(size, { price: 1, liquidityUsd, dexId, solPriceUsd }, cfg.costs) })),
  };
}
