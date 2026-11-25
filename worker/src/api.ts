import { CONFIG } from "./config";
import { schedulerStub } from "./stub";
import type { Env } from "./types";

// Read-only JSON API for the dashboard, plus a few admin actions.
//   GET  /api/summary      wallet, PnL, counts, scheduler + last run
//   GET  /api/candidates   latest candidate feed with pass/fail reasons
//   GET  /api/positions    open positions
//   GET  /api/trades       closed trades (sell legs) + buys
//   GET  /api/decisions    decision log
//   GET  /api/equity       equity curve (downsampled)
//   POST /api/run          run one tick now          (Bearer ADMIN_TOKEN)
//   POST /api/pause|resume pause / resume ticking    (Bearer ADMIN_TOKEN)
//   POST /api/reset        wipe and restart at $1000 (Bearer ADMIN_TOKEN)

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
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
          const fees = await db.prepare("SELECT COALESCE(SUM(fees_usd),0) AS f FROM trades").first<{ f: number }>();
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
            totalFees: fees?.f ?? 0,
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
