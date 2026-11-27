import { CONFIG } from "./config";
import { LEGACY_ROUND_TRIP_PCT, roundTripCost } from "./strategy/broker";
import { schedulerStub } from "./stub";
import type { Env } from "./types";

// Read-only JSON API for the dashboard, plus a few admin actions.
//   GET  /api/summary      wallet, PnL, counts, scheduler + last run
//   GET  /api/candidates   latest candidate feed with pass/fail reasons
//   GET  /api/positions    open positions
//   GET  /api/orders       pending orders (decided, not yet filled)
//   GET  /api/trades       closed trades (sell legs) + buys
//   GET  /api/decisions    decision log
//   GET  /api/equity       equity curve (downsampled)
//   POST /api/run          run one tick now          (Bearer ADMIN_TOKEN)
//   POST /api/pause|resume pause / resume ticking    (Bearer ADMIN_TOKEN)
//   POST /api/reset        wipe and restart at $1000 (Bearer ADMIN_TOKEN)

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

  try {
    if (req.method === "GET") {
      switch (url.pathname) {
        case "/":
        case "/api":
          return json({ ok: true, simulated: true, name: "solsnyper paper-trading worker" });

        case "/api/summary": {
          const wallet = await db.prepare("SELECT * FROM wallet WHERE id=1").first();
          const realized = await db
            .prepare("SELECT COALESCE(SUM(pnl_usd),0) AS pnl, COUNT(*) AS n, SUM(CASE WHEN pnl_usd>0 THEN 1 ELSE 0 END) AS wins, COALESCE(SUM(fees_usd),0) AS sell_fees FROM trades WHERE side='sell'")
            .first<{ pnl: number; n: number; wins: number; sell_fees: number }>();
          const c = await db
            .prepare("SELECT COALESCE(SUM(dex_fee_usd),0) AS dex, COALESCE(SUM(network_fee_usd),0) AS net, COALESCE(SUM(slippage_usd),0) AS slip FROM trades")
            .first<{ dex: number; net: number; slip: number }>();
          const costs = { dexFeesUsd: c?.dex ?? 0, networkFeesUsd: c?.net ?? 0, slippageUsd: c?.slip ?? 0, totalUsd: (c?.dex ?? 0) + (c?.net ?? 0) + (c?.slip ?? 0) };
          const pendingOrders = (await db.prepare("SELECT COUNT(*) AS n FROM pending_orders").first<{ n: number }>())?.n ?? 0;
          const openAgg = await db
            .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(unrealized_pnl),0) AS u, COALESCE(SUM(size_usd),0) AS exposure FROM positions WHERE status='open'")
            .first<{ n: number; u: number; exposure: number }>();
          const lastRun = await db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").first();
          let scheduler: unknown = null;
          try {
            scheduler = await (await schedulerStub(env).fetch("https://do/status")).json();
          } catch {
            /* DO unavailable in some local setups */
          }
          return json({
            simulated: true,
            wallet,
            realizedPnl: realized?.pnl ?? 0,
            closedTrades: realized?.n ?? 0,
            wins: realized?.wins ?? 0,
            totalFees: costs.totalUsd,
            costs,
            pendingOrders,
            costExamples: costExamples((wallet as { sol_price_usd?: number } | null)?.sol_price_usd || CONFIG.costs.fallbackSolPriceUsd),
            openPositions: openAgg?.n ?? 0,
            unrealizedPnl: openAgg?.u ?? 0,
            exposureUsd: openAgg?.exposure ?? 0,
            lastRun,
            scheduler,
            config: CONFIG,
          });
        }

        case "/api/candidates":
          return json(
            (await db.prepare("SELECT * FROM candidates ORDER BY last_seen DESC, flagged DESC, score DESC LIMIT ?").bind(limit).all()).results,
          );

        case "/api/orders":
          return json((await db.prepare("SELECT * FROM pending_orders ORDER BY id DESC").all()).results);

        case "/api/positions":
          return json((await db.prepare("SELECT * FROM positions WHERE status='open' ORDER BY entry_time DESC").all()).results);

        case "/api/closed":
          return json((await db.prepare("SELECT * FROM positions WHERE status='closed' ORDER BY exit_time DESC LIMIT ?").bind(limit).all()).results);

        case "/api/trades":
          return json((await db.prepare("SELECT * FROM trades ORDER BY timestamp DESC, id DESC LIMIT ?").bind(limit).all()).results);

        case "/api/decisions": {
          const action = url.searchParams.get("action");
          const stmt = action
            ? db.prepare("SELECT * FROM decisions WHERE action=? ORDER BY id DESC LIMIT ?").bind(action, limit)
            : db.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?").bind(limit);
          return json((await stmt.all()).results);
        }

        case "/api/equity": {
          const hours = Math.min(24 * 30, Math.max(1, parseInt(url.searchParams.get("hours") ?? "24", 10) || 24));
          const since = Date.now() - hours * 3_600_000;
          // bucket so we return at most ~300 points
          const bucket = Math.max(45_000, Math.ceil((hours * 3_600_000) / 300));
          const rows = await db
            .prepare(
              "SELECT (timestamp / ?) * ? AS t, AVG(equity_usd) AS equity, AVG(cash_usd) AS cash FROM equity_snapshots WHERE timestamp > ? GROUP BY timestamp / ? ORDER BY t",
            )
            .bind(bucket, bucket, since, bucket)
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
          const start = CONFIG.wallet.startingEquityUsd;
          await db.batch([
            db.prepare("DELETE FROM positions"),
            db.prepare("DELETE FROM trades"),
            db.prepare("DELETE FROM candidates"),
            db.prepare("DELETE FROM decisions"),
            db.prepare("DELETE FROM equity_snapshots"),
            db.prepare("DELETE FROM runs"),
            db.prepare("DELETE FROM pending_orders"),
            db.prepare("UPDATE wallet SET cash_usd=?, cash_sol=0, equity_usd=?, starting_equity=?, updated_at=? WHERE id=1").bind(start, start, start, Date.now()),
          ]);
          return json({ reset: true, startingEquity: start });
        }
      }
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

/**
 * What a buy + immediate sell at an unchanged price costs with the current
 * settings, for a few typical pools. Shown on the dashboard so the cost of a
 * round trip is visible before tuning take-profit / stop levels.
 */
function costExamples(solPriceUsd: number) {
  const size = CONFIG.wallet.buySizeUsd;
  const pools: [string, string, number][] = [
    ["pump.fun curve, $25k", "pumpfun", 25_000],
    ["PumpSwap, $25k", "pumpswap", 25_000],
    ["Raydium, $25k", "raydium", 25_000],
    ["Raydium, $250k", "raydium", 250_000],
  ];
  return {
    sizeUsd: size,
    solPriceUsd,
    legacyFlatUsd: size * LEGACY_ROUND_TRIP_PCT,
    rows: pools.map(([label, dexId, liquidityUsd]) => ({ label, dexId, liquidityUsd, ...roundTripCost(size, { price: 1, liquidityUsd, dexId, solPriceUsd }, CONFIG.costs) })),
  };
}
