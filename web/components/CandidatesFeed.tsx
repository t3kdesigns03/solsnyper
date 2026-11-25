"use client";

import { useState } from "react";
import { usePoll } from "@/lib/api";
import { ago, compactUsd, price } from "@/lib/format";
import type { Candidate } from "@/lib/types";
import { Badge, Empty, ErrorNote, MintLink, Panel, Td, Th } from "./ui";

// Held / cooling-down mints aren't failures, just not buyable right now.
function ResultBadge({ c }: { c: Candidate }) {
  if (c.flagged) return <Badge kind="pass">pass</Badge>;
  const r = c.reject_reason ?? "";
  if (r.startsWith("already holding")) return <Badge kind="sell">held</Badge>;
  if (r.includes("(cooldown)")) return <Badge kind="skip">cooldown</Badge>;
  return <Badge kind="fail">fail</Badge>;
}

export function CandidatesFeed() {
  const { data, error } = usePoll<Candidate[]>("/api/candidates?limit=150", 10_000);
  const [onlyPass, setOnlyPass] = useState(false);
  const rows = (data ?? []).filter((c) => !onlyPass || c.flagged);
  const passCount = (data ?? []).filter((c) => c.flagged).length;

  return (
    <Panel
      title="Live candidate feed"
      right={
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={onlyPass} onChange={(e) => setOnlyPass(e.target.checked)} className="accent-violet-500" />
          passed only ({passCount}/{data?.length ?? 0})
        </label>
      }
    >
      <ErrorNote error={error} />
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-900">
            <tr>
              <Th>Token</Th>
              <Th>Result</Th>
              <Th>Reason</Th>
              <Th right>Liq</Th>
              <Th right>Vol 1h</Th>
              <Th right>Age</Th>
              <Th right>Price</Th>
              <Th right>Score</Th>
              <Th>Source</Th>
              <Th right>Seen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {rows.length === 0 && <Empty cols={10}>{data ? "No candidates yet." : "Loading…"}</Empty>}
            {rows.map((c) => (
              <tr key={c.mint} className={c.flagged ? "bg-emerald-500/5" : ""}>
                <Td><MintLink mint={c.mint} symbol={c.symbol} /></Td>
                <Td><ResultBadge c={c} /></Td>
                <Td className="max-w-[280px] truncate text-zinc-400"><span title={c.reject_reason ?? "passed all filters"}>{c.reject_reason ?? "passed all filters"}</span></Td>
                <Td right>{compactUsd(c.liquidity)}</Td>
                <Td right>{compactUsd(c.volume)}</Td>
                <Td right>{c.age_minutes === null ? "—" : `${c.age_minutes.toFixed(0)}m`}</Td>
                <Td right className="font-mono text-xs">{price(c.price)}</Td>
                <Td right>{c.score?.toFixed(1) ?? "—"}</Td>
                <Td className="text-xs text-zinc-500">{c.source}</Td>
                <Td right className="text-xs text-zinc-500">{ago(c.last_seen)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
