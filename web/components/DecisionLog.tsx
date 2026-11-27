"use client";

import { useState } from "react";
import { usePoll } from "@/lib/api";
import { shortMint, time } from "@/lib/format";
import type { Decision } from "@/lib/types";
import { Badge, Empty, ErrorNote, Panel, Td, Th } from "./ui";

const FILTERS = ["all", "order", "buy", "sell", "cancel", "skip", "reject"] as const;

export function DecisionLog() {
  const [f, setF] = useState<(typeof FILTERS)[number]>("all");
  const { data, error } = usePoll<Decision[]>(`/api/decisions?limit=200${f === "all" ? "" : `&action=${f}`}`, 10_000);
  const rows = (data ?? []).filter((d) => f === "all" || d.action === f);

  return (
    <Panel
      title="Decision log"
      right={
        <div className="flex gap-1">
          {FILTERS.map((x) => (
            <button key={x} onClick={() => setF(x)} className={`rounded px-2 py-0.5 capitalize ${f === x ? "bg-violet-500/20 text-violet-200" : "hover:bg-zinc-800"}`}>
              {x}
            </button>
          ))}
        </div>
      }
    >
      <ErrorNote error={error} />
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-900">
            <tr>
              <Th>Time</Th>
              <Th>Action</Th>
              <Th>Mint</Th>
              <Th right>Score</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {rows.length === 0 && <Empty cols={5}>{data ? "No decisions yet." : "Loading…"}</Empty>}
            {rows.map((d) => (
              <tr key={d.id}>
                <Td className="text-xs text-zinc-500">{time(d.timestamp)}</Td>
                <Td><Badge kind={d.action} /></Td>
                <Td className="font-mono text-xs text-zinc-400">
                  <a href={`https://dexscreener.com/solana/${d.mint}`} target="_blank" rel="noreferrer" className="hover:text-violet-300">{shortMint(d.mint)}</a>
                </Td>
                <Td right>{d.score?.toFixed(1) ?? "—"}</Td>
                <Td className="whitespace-normal text-zinc-300">{d.reason}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">A rejected mint is logged again only when its reject reason changes.</p>
    </Panel>
  );
}
