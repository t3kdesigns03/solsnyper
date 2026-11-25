"use client";

import { usePoll } from "@/lib/api";
import { usd } from "@/lib/format";
import type { EquityPoint, Summary } from "@/lib/types";
import { Panel } from "./ui";

const W = 800;
const H = 200;
const PAD = { l: 56, r: 12, t: 12, b: 22 };

export function EquityChart() {
  const { data } = usePoll<EquityPoint[]>("/api/equity?hours=24", 30_000);
  const { data: s } = usePoll<Summary>("/api/summary", 30_000);
  const pts = data ?? [];
  const base = s?.wallet.starting_equity ?? 1000;

  let body = <div className="px-4 py-10 text-center text-sm text-zinc-500">No equity history yet: the curve appears after the first ticks.</div>;

  if (pts.length >= 2) {
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const vals = pts.map((p) => p.equity).concat(base);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.1, 1);
    lo -= pad;
    hi += pad;
    const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
    const last = pts[pts.length - 1].equity;
    const up = last >= base;
    const color = up ? "#34d399" : "#fb7185";
    const area = `${line}L${x(t1).toFixed(1)},${y(lo)}L${x(t0).toFixed(1)},${y(lo)}Z`;
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
    const fmtT = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    body = (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-52 w-full" role="img" aria-label={`Equity curve, now ${usd(last)}`}>
        <defs>
          <linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#27272a" />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="fill-zinc-500 text-[10px]">{usd(v, 0)}</text>
          </g>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(base)} y2={y(base)} stroke="#71717a" strokeDasharray="4 4" />
        <path d={area} fill="url(#eqfill)" />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        <circle cx={x(t1)} cy={y(last)} r="3.5" fill={color} />
        <text x={PAD.l} y={H - 4} className="fill-zinc-500 text-[10px]">{fmtT(t0)}</text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" className="fill-zinc-500 text-[10px]">{fmtT(t1)}</text>
      </svg>
    );
  }

  return (
    <Panel title="Equity curve (24h)" right={<span>dashed line = starting equity</span>}>
      <div className="px-2 py-2">{body}</div>
    </Panel>
  );
}
