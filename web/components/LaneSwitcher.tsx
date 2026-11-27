"use client";

import { usePoll } from "@/lib/api";
import { pnlClass, signedUsd, usd } from "@/lib/format";
import { LANES, useLane } from "@/lib/lane";
import type { LaneStats } from "@/lib/types";

/** Side-by-side scoreboard of both paper wallets; click one to view it. */
export function LaneSwitcher() {
  const { lane, setLane } = useLane();
  const { data } = usePoll<LaneStats[]>("/api/lanes", 10_000);
  const byLane = new Map((data ?? []).map((l) => [l.lane, l]));

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {LANES.map((l) => {
        const s = byLane.get(l.id);
        const total = s ? s.wallet.equity_usd - s.wallet.starting_equity : 0;
        const winRate = s && s.closedTrades ? s.wins / s.closedTrades : 0;
        const active = lane === l.id;
        return (
          <button
            key={l.id}
            onClick={() => setLane(l.id)}
            className={`rounded-lg border px-4 py-3 text-left transition ${active ? "border-violet-500/60 bg-violet-500/10" : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"}`}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold text-zinc-100">
                {l.label} <span className="font-normal text-zinc-500">· {l.blurb}</span>
              </span>
              {active && <span className="text-[11px] uppercase tracking-wider text-violet-300">viewing</span>}
            </div>
            {s ? (
              <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
                <span className="text-zinc-200">{usd(s.wallet.equity_usd)}</span>
                <span className={pnlClass(total)}>
                  {signedUsd(total)} ({s.wallet.starting_equity ? ((total / s.wallet.starting_equity) * 100).toFixed(1) : "0.0"}%)
                </span>
                <span className="text-zinc-400">
                  {s.closedTrades} trades · {(winRate * 100).toFixed(0)}% wins
                </span>
                <span className="text-zinc-400">{s.openPositions} open</span>
                <span className="text-amber-300/90">costs {usd(s.costs.totalUsd)}</span>
              </div>
            ) : (
              <div className="mt-1.5 text-sm text-zinc-500">loading…</div>
            )}
          </button>
        );
      })}
    </div>
  );
}
