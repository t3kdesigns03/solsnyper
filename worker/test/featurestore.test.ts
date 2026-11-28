import { describe, expect, it } from "vitest";
import { runTick, type Sources } from "../src/engine";
import { toRiskSummary } from "../src/sources/rugcheck";
import type { Env, MarketSnapshot } from "../src/types";
import { makeD1 } from "./d1shim";
import { T0, snap } from "./fixtures";

describe("feature store", () => {
  it("samples sniper coins every tick, keeps pricing them via the watchlist, and caches risk", async () => {
    const { d1, raw } = makeD1();
    const env = { DB: d1 } as unknown as Env;
    const young = snap({ liquidityUsd: 15_000 }); // too thin to buy, but worth tracking (>= $10k)
    const dust = snap({ mint: "Dust".padEnd(40, "1"), liquidityUsd: 2_000 }); // not tracked
    let discovered = [young, dust];
    const pricedAsked: string[][] = [];
    let riskAsked: string[] = [];
    const sources: Sources = {
      discover: async () => ({ mints: [], errors: [] }),
      snapshots: async () => new Map(),
      solPrice: async () => 72,
      market: async (_env, held, _now, opts) => {
        pricedAsked.push(held);
        riskAsked = opts?.riskMints ?? [];
        const all = new Map<string, MarketSnapshot>([young, dust].map((s) => [s.mint, s]));
        return {
          mints: discovered.map((s) => ({ mint: s.mint, source: "test" })),
          established: [],
          errors: [],
          snapshots: all,
          solPrice: 72,
          risk: Object.fromEntries((opts?.riskMints ?? []).map((m) => [m, toRiskSummary({ score: 500, score_normalised: 5, lpLockedPct: 0, risks: [{ name: "Mint Authority still enabled", level: "danger" }] })])),
        };
      },
    };
    const q = (sql: string) => raw.prepare(sql).all() as any[];

    // Tick 1: first sample. The tracked coin is recorded and added to the watchlist; dust isn't.
    await runTick(env, T0, sources);
    expect(q("SELECT lane, mint, verdict FROM candidate_snapshots")).toEqual([{ lane: "sniper", mint: young.mint, verdict: "reject" }]);
    expect(q("SELECT mint, until FROM watchlist")).toEqual([{ mint: young.mint, until: T0 + 70 * 60_000 }]);

    // Tick 2 (45s later): the sniper samples every tick; the coin is no longer a candidate, so it is
    // priced via the watchlist and recorded as "watch". The new watchlist coin also gets a risk lookup.
    discovered = []; // the coin is no longer a candidate
    await runTick(env, T0 + 45_000, sources);
    expect(riskAsked).toEqual([young.mint]);
    const risk = q("SELECT mint, score, lp_locked_pct, risks FROM token_risk")[0];
    expect(risk).toMatchObject({ mint: young.mint, score: 500, lp_locked_pct: 0 });
    expect(JSON.parse(risk.risks)[0].name).toBe("Mint Authority still enabled");
    expect(q("SELECT verdict FROM candidate_snapshots ORDER BY t").map((r) => r.verdict)).toEqual(["reject", "watch"]);

    // A later tick: still tracked via the watchlist.
    await runTick(env, T0 + 180_000, sources);
    expect(pricedAsked.at(-1)).toContain(young.mint);
    expect(q("SELECT verdict FROM candidate_snapshots ORDER BY t").map((r) => r.verdict)).toEqual(["reject", "watch", "watch"]);
    expect(riskAsked).toEqual([]); // cached: not looked up again
  });
});
