"use client";

import { usePoll } from "@/lib/api";
import { pct, pnlClass, price, signedUsd, time, usd } from "@/lib/format";
import type { Position } from "@/lib/types";
import { Badge, Empty, ErrorNote, MintLink, Panel, Td, Th } from "./ui";

export function ClosedTrades() {
  const { data, error } = usePoll<Position[]>("/api/closed?limit=100", 10_000);
  const rows = data ?? [];
  return (
    <Panel title="Closed trades" right={`last ${rows.length} · costs = DEX/gas/slippage`}>
      <ErrorNote error={error} />
      <div className="max-h-[380px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-900">
            <tr>
              <Th>Token</Th>
              <Th>Exit</Th>
              <Th right>Entry</Th>
              <Th right>Exit px</Th>
              <Th right>Move</Th>
              <Th right>Costs</Th>
              <Th right>PnL (net)</Th>
              <Th right>Held</Th>
              <Th right>Closed</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {rows.length === 0 && <Empty cols={9}>{data ? "No closed trades yet." : "Loading…"}</Empty>}
            {rows.map((p) => {
              const move = (p.exit_price ?? p.current_price) / p.entry_price - 1;
              const rule = (p.close_reason ?? "").split(":")[0];
              const held = p.exit_time ? (p.exit_time - p.entry_time) / 60_000 : 0;
              const dex = (p.entry_dex_fee_usd ?? 0) + (p.exit_dex_fee_usd ?? 0);
              const gas = (p.entry_network_fee_usd ?? 0) + (p.exit_network_fee_usd ?? 0);
              const slip = (p.entry_slippage_usd ?? 0) + (p.exit_slippage_usd ?? 0);
              const fills =
                p.entry_signal_price && p.exit_signal_price
                  ? `Signal → fill: entry ${price(p.entry_signal_price)} → ${price(p.entry_price)}, exit ${price(p.exit_signal_price)} → ${price(p.exit_price)}`
                  : "";
              return (
                <tr key={p.id}>
                  <Td><MintLink mint={p.mint} symbol={p.symbol} /></Td>
                  <Td><span title={p.close_reason ?? ""}><Badge kind={rule === "take_profit" ? "buy" : rule === "hard_stop" || rule === "liquidity_collapse" ? "error" : "skip"}>{rule.replace("_", " ")}</Badge></span></Td>
                  <Td right className="font-mono text-xs">{price(p.entry_price)}</Td>
                  <Td right className="font-mono text-xs">{price(p.exit_price)}</Td>
                  <Td right className={pnlClass(move)}>{pct(move)}</Td>
                  <Td right className="text-xs">
                    <span title={`${p.dex_id ?? "unknown DEX"} · DEX fees ${usd(dex)} · gas ${usd(gas)} · slippage ${usd(slip)}${fills ? " · " + fills : ""}`}>
                      <span className="text-amber-300">{usd(dex + gas + slip)}</span>
                      <span className="ml-1 text-zinc-500">
                        {usd(dex)}/{usd(gas)}/{usd(slip)}
                      </span>
                    </span>
                  </Td>
                  <Td right className={`font-medium ${pnlClass(p.realized_pnl)}`}>{signedUsd(p.realized_pnl ?? 0)}</Td>
                  <Td right className="text-zinc-400">{held.toFixed(1)}m</Td>
                  <Td right className="text-xs text-zinc-500">{p.exit_time ? time(p.exit_time) : "—"}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
