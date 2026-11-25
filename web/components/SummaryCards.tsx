"use client";

import { usePoll } from "@/lib/api";
import { ago, pnlClass, signedUsd, usd, pct } from "@/lib/format";
import type { Summary } from "@/lib/types";

function Card({ label, value, sub, valueClass = "text-zinc-100" }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

export function SummaryCards() {
  const { data: s, error } = usePoll<Summary>("/api/summary", 5_000);
  if (!s) return <div className="text-sm text-zinc-500">{error ? `Can't reach the Worker: ${error}` : "Loading wallet…"}</div>;

  const w = s.wallet;
  const total = w.equity_usd - w.starting_equity;
  const winRate = s.closedTrades ? s.wins / s.closedTrades : 0;
  const nextIn = s.scheduler?.nextAlarm ? Math.max(0, Math.round((s.scheduler.nextAlarm - Date.now()) / 1000)) : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card label="Equity (simulated)" value={usd(w.equity_usd)} sub={`started at ${usd(w.starting_equity, 0)}`} />
        <Card label="Total PnL" value={signedUsd(total)} sub={pct(total / w.starting_equity)} valueClass={pnlClass(total)} />
        <Card label="Realized" value={signedUsd(s.realizedPnl)} sub={`${s.closedTrades} trades · ${(winRate * 100).toFixed(0)}% wins`} valueClass={pnlClass(s.realizedPnl)} />
        <Card label="Unrealized" value={signedUsd(s.unrealizedPnl)} sub={`${s.openPositions} open · ${usd(s.exposureUsd, 0)} in`} valueClass={pnlClass(s.unrealizedPnl)} />
        <Card label="Cash" value={usd(w.cash_usd)} sub={w.sol_price_usd ? `≈ ${w.cash_sol.toFixed(3)} SOL @ ${usd(w.sol_price_usd)}` : "SOL price pending"} />
        <Card label="Fees paid" value={usd(s.totalFees)} sub="0.8% round trip (est.)" />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span>
          Last tick {ago(s.lastRun?.started_at)}
          {s.lastRun && ` · ${s.lastRun.candidates_seen} candidates · ${s.lastRun.buys} buys · ${s.lastRun.sells} sells · ${s.lastRun.duration_ms}ms`}
        </span>
        <span>{s.scheduler?.paused ? "Scheduler PAUSED" : nextIn !== null ? `Next tick in ${nextIn}s` : ""}</span>
        {s.lastRun?.errors && <span className="text-amber-400">Source warnings: {s.lastRun.errors}</span>}
      </div>
    </div>
  );
}
