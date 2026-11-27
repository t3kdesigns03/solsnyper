"use client";

import { usePoll } from "@/lib/api";
import { compactUsd, usd } from "@/lib/format";
import type { Summary } from "@/lib/types";
import { Panel, Td, Th } from "./ui";

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

/** The active cost model (from worker/src/config.ts) and what a round trip costs with it. */
export function CostSettings() {
  const { data: s } = usePoll<Summary>("/api/summary", 30_000);
  if (!s) return null;
  const c = s.config.costs;
  const ex = s.costExamples;
  const cc = s.config.costControl;
  const patient = !!c.usePatientPriorityFee;
  const priority = patient ? (c.patientPriorityFeeSol ?? c.priorityFeeSol) : c.priorityFeeSol;
  const gasSol = c.networkFeeSol + priority;
  const dexes = Object.entries(c.dexFeePct).sort(([a], [b]) => (a === "default" ? 1 : b === "default" ? -1 : a.localeCompare(b)));

  return (
    <Panel title="Cost model" right="edit worker/src/config.ts → costs, then redeploy">
      <div className="grid gap-4 p-4 text-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-zinc-500">DEX fee</dt>
          <dd className="text-zinc-200">{dexes.map(([k, v]) => `${k} ${pct(v)}`).join(" · ")}</dd>
          <dt className="text-zinc-500">Gas / tx</dt>
          <dd className="text-zinc-200">
            {+gasSol.toFixed(6)} SOL ({c.networkFeeSol} base + {priority} {patient ? "patient" : ""} priority) ≈ {usd(gasSol * ex.solPriceUsd, 3)}
          </dd>
          <dt className="text-zinc-500">Slippage</dt>
          <dd className="text-zinc-200">price impact size ÷ (liquidity/2 + size), plus {pct(c.extraSlippagePct, 1)} buffer</dd>
          <dt className="text-zinc-500">Fill timing</dt>
          <dd className="text-zinc-200">
            {c.fillDelayTicks === 0
              ? "instant, at the price that triggered the trade"
              : `${c.fillDelayTicks} tick${c.fillDelayTicks === 1 ? "" : "s"} later (~${Math.round((c.fillDelayTicks * s.config.tickIntervalMs) / 1000)}s), at that tick's price`}
          </dd>
          {cc && (
            <>
              <dt className="col-span-2 mt-2 text-[11px] uppercase tracking-wider text-zinc-500">Cost control</dt>
              <dt className="text-zinc-500">Max round trip</dt>
              <dd className="text-zinc-200">
                {pct(cc.maxRoundTripCostPct, 1)} of the trade, checked at the signal and again at fill (drained pools get cancelled)
              </dd>
              <dt className="text-zinc-500">Min edge</dt>
              <dd className="text-zinc-200">take-profit ≥ {cc.minEdgeMultiple}× the pool&apos;s round-trip cost</dd>
              <dt className="text-zinc-500">Pace</dt>
              <dd className="text-zinc-200">max {cc.maxBuysPerHour} buys per rolling hour</dd>
              <dt className="text-zinc-500">Venues</dt>
              <dd className="text-zinc-200">pump.fun curve {cc.skipPumpFunCurve ? "skipped" : "allowed (cost cap still applies)"}</dd>
              <dt className="text-zinc-500">Relaunches</dt>
              <dd className="text-zinc-200">
                {cc.symbolCooldownMinutes > 0 ? `skip a symbol bought in the last ${cc.symbolCooldownMinutes}m under another mint` : "off (same symbol, new mint allowed)"}
              </dd>
            </>
          )}
        </dl>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>${ex.sizeUsd} round trip, flat price</Th>
              <Th right>DEX</Th>
              <Th right>Gas</Th>
              <Th right>Slippage</Th>
              <Th right>Total</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {ex.rows.map((r) => (
              <tr key={r.label}>
                <Td>
                  {r.label.split(",")[0]} <span className="text-zinc-500">{compactUsd(r.liquidityUsd)}</span>
                </Td>
                <Td right>{usd(r.dexFeeUsd)}</Td>
                <Td right>{usd(r.networkFeeUsd)}</Td>
                <Td right>{usd(r.slippageUsd)}</Td>
                <Td right className="font-medium text-amber-300">
                  {usd(r.totalUsd)} <span className="text-xs text-zinc-500">{pct(r.pctOfSize, 1)}</span>
                </Td>
              </tr>
            ))}
            <tr>
              <Td className="text-zinc-500">Old flat model (0.8%)</Td>
              <Td right className="text-zinc-500">{usd(ex.legacyFlatUsd)}</Td>
              <Td right className="text-zinc-500">—</Td>
              <Td right className="text-zinc-500">—</Td>
              <Td right className="text-zinc-500">{usd(ex.legacyFlatUsd)}</Td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
