import { CONFIG } from "./config";
import { liveSources, runTick } from "./engine";
import { mockSources } from "./sources/mock";
import { handleApi } from "./api";
import { schedulerStub } from "./stub";
import type { Env } from "./types";

// ── Why a Durable Object? ───────────────────────────────────────────────────
// Cloudflare cron triggers can't fire more often than once a minute. To tick
// every 45s, a single Durable Object ("Scheduler") sets an alarm 45s ahead,
// runs a tick when it fires, and re-arms itself. Alarms are retried by
// Cloudflare on failure and never run concurrently, so ticks can't overlap
// and double-buy. The once-a-minute cron is only a watchdog: it re-arms the
// alarm if it was ever lost (first deploy, or after a pause).
// ────────────────────────────────────────────────────────────────────────────

export class Scheduler implements DurableObject {
  private running = false;
  constructor(private state: DurableObjectState, private env: Env) {}

  /**
   * In-memory lock so a manual /run-now can't interleave with an alarm tick.
   * The tick itself runs in the Worker (via the SELF service binding), not in
   * this object: a Durable Object instance can keep running old code after a
   * deploy, but a fresh Worker request always runs the latest version.
   */
  private async tickOnce(): Promise<unknown> {
    if (this.running) return { skipped: "tick already running" };
    this.running = true;
    try {
      if (this.env.SELF) {
        const res = await this.env.SELF.fetch("https://self" + TICK_PATH, { method: "POST", headers: { "x-tick-token": this.env.ADMIN_TOKEN ?? "" } });
        const body = (await res.json()) as unknown;
        if (!res.ok) throw new Error(`tick endpoint ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
        return body;
      }
      return await runTick(this.env, Date.now(), this.env.MOCK_MARKET === "true" ? mockSources : liveSources);
    } finally {
      this.running = false;
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ensure") {
      const cur = await this.state.storage.getAlarm();
      if (cur === null) await this.state.storage.setAlarm(Date.now() + 1_000);
      return Response.json({ alarm: cur ?? "armed" });
    }
    if (url.pathname === "/run-now") {
      return Response.json(await this.tickOnce());
    }
    if (url.pathname === "/pause") {
      await this.state.storage.deleteAlarm();
      await this.state.storage.put("paused", true);
      return Response.json({ paused: true });
    }
    if (url.pathname === "/resume") {
      await this.state.storage.delete("paused");
      await this.state.storage.setAlarm(Date.now() + 1_000);
      return Response.json({ paused: false });
    }
    if (url.pathname === "/status") {
      return Response.json({ nextAlarm: await this.state.storage.getAlarm(), paused: !!(await this.state.storage.get("paused")) });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    if (await this.state.storage.get("paused")) return;
    // Arm the next tick first so a slow or failing tick doesn't stop the loop.
    await this.state.storage.setAlarm(Date.now() + CONFIG.tickIntervalMs);
    try {
      await this.tickOnce();
    } catch (e) {
      console.error("tick failed", e);
      await this.env.DB.prepare(`INSERT INTO runs (started_at, duration_ms, candidates_seen, buys, sells, errors) VALUES (?,0,0,0,0,?)`)
        .bind(Date.now(), `fatal: ${String(e)}`)
        .run();
    }
  }
}

/** Internal endpoint the scheduler calls through the SELF service binding. */
export const TICK_PATH = "/__tick";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === TICK_PATH) {
      // Only the scheduler knows this token; the path is never meant for browsers.
      if (req.method !== "POST" || !env.ADMIN_TOKEN || req.headers.get("x-tick-token") !== env.ADMIN_TOKEN) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      return Response.json(await runTick(env, Date.now(), env.MOCK_MARKET === "true" ? mockSources : liveSources));
    }
    return handleApi(req, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = schedulerStub(env);
    const status = (await (await stub.fetch("https://do/status")).json()) as { paused: boolean };
    if (!status.paused) ctx.waitUntil(stub.fetch("https://do/ensure"));
  },
} satisfies ExportedHandler<Env>;
