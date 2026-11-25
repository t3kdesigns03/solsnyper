"use client";

import { usePoll } from "@/lib/api";
import { ago, pct, pnlClass, price, signedUsd, usd } from "@/lib/format";
import type { Position } from "@/lib/types";
import { Empty, ErrorNote, MintLink, Panel, Td, Th } from "./ui";

export function PositionsTable() {
  const { data, error } = usePoll<Position[]>("/api/positions", 5_000);
  const rows = data ?? [];
  return (
    <Panel title="Open positions" right={`${rows.length} open`}>
      <ErrorNote error={error} />
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>Token</Th>
            <Th right>Size</Th>
            <Th right>Entry</Th>
            <Th right>Current</Th>
            <Th right>Move</Th>
            <Th right>Peak</Th>
            <Th right>Unrealized</Th>
            <Th right>Held</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/70">
          {rows.length === 0 && <Empty cols={8}>{data ? "No open positions." : "Loading…"}</Empty>}
          {rows.map((p) => {
            const move = p.current_price / p.entry_price - 1;
            return (
              <tr key={p.id}>
                <Td><MintLink mint={p.mint} symbol={p.symbol} /></Td>
                <Td right>{usd(p.size_usd)}</Td>
                <Td right className="font-mono text-xs">{price(p.entry_price)}</Td>
                <Td right className="font-mono text-xs">{price(p.current_price)}</Td>
                <Td right className={pnlClass(move)}>{pct(move)}</Td>
                <Td right className="text-zinc-400">{pct(p.peak_price / p.entry_price - 1)}</Td>
                <Td right className={`font-medium ${pnlClass(p.unrealized_pnl)}`}>{signedUsd(p.unrealized_pnl)}</Td>
                <Td right className="text-zinc-400">{ago(p.entry_time).replace(" ago", "")}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">Unrealized PnL is net of the entry fee and the estimated exit fee.</p>
    </Panel>
  );
}
