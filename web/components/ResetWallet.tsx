"use client";

import { useEffect, useState } from "react";
import { API_URL, DEMO } from "@/lib/config";
import { usd } from "@/lib/format";
import { LANES, type Lane, useLane } from "@/lib/lane";
import { Panel } from "./ui";

// Reset the paper wallet to a new starting amount. The site is public, so this
// needs the Worker's ADMIN_TOKEN; it is kept only in this browser's localStorage
// and sent only to the Worker API. Resetting wipes all trades, positions and
// history (it cannot be undone); the 45s loop keeps running afterwards.

const TOKEN_KEY = "solsnyper.adminToken";

export function ResetWallet() {
  const { lane } = useLane();
  const [target, setTarget] = useState<Lane>(lane);
  useEffect(() => setTarget(lane), [lane]);
  const targetLabel = LANES.find((l) => l.id === target)?.label ?? target;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("10000");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    try {
      setToken(localStorage.getItem(TOKEN_KEY) ?? "");
    } catch {
      /* storage blocked */
    }
  }, []);

  const n = Number(amount);
  const amountOk = Number.isFinite(n) && n >= 100 && n <= 1_000_000;
  const ready = amountOk && token.trim().length > 0 && confirm === "RESET" && !busy && !DEMO;

  async function reset() {
    setBusy(true);
    setResult(null);
    try {
      try {
        if (remember) localStorage.setItem(TOKEN_KEY, token.trim());
        else localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* storage blocked */
      }
      const res = await fetch(`${API_URL}/api/reset`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ lane: target, startingEquity: n }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; startingEquity?: number };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setResult({ ok: true, text: `${targetLabel} wallet reset to ${usd(body.startingEquity ?? n, 0)}. Tracking continues; the first tick runs within a few seconds.` });
      setConfirm("");
      setOpen(false);
    } catch (e) {
      setResult({ ok: false, text: `Reset failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Paper wallet"
      right={
        <button onClick={() => setOpen((o) => !o)} className="rounded px-2 py-0.5 text-rose-300 hover:bg-rose-500/10">
          {open ? "Cancel" : "Reset paper wallet…"}
        </button>
      }
    >
      {result && <div className={`px-4 py-2 text-sm ${result.ok ? "text-emerald-300" : "text-rose-300"}`}>{result.text}</div>}
      {open && (
        <form
          className="grid gap-3 p-4 text-sm md:grid-cols-[repeat(3,minmax(0,1fr))_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) reset();
          }}
        >
          <p className="rounded border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-rose-200 md:col-span-4">
            This deletes every trade, position, order and chart point of the chosen lane and restarts its simulated wallet.{" "}
            <b>It cannot be undone.</b> The other lane is not touched, and the bot keeps tracking afterwards. Simulated money only.
          </p>
          <label className="grid gap-1 md:col-span-4">
            <span className="text-xs text-zinc-500">Lane to reset</span>
            <span className="flex gap-2">
              {LANES.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setTarget(l.id)}
                  className={`rounded px-3 py-1 ${target === l.id ? "bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/40" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
                >
                  {l.label} <span className="text-xs opacity-70">({l.blurb})</span>
                </button>
              ))}
            </span>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-zinc-500">Starting amount (USD, 100 – 1,000,000)</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              className={`rounded border bg-zinc-950 px-2 py-1.5 tabular-nums ${amountOk ? "border-zinc-700" : "border-rose-600"}`}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-zinc-500">Admin token (stays in this browser)</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
            />
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> remember on this device
            </span>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-zinc-500">
              Type <b className="text-zinc-300">RESET</b> to confirm
            </span>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5" />
          </label>
          <button
            type="submit"
            disabled={!ready}
            className="rounded bg-rose-600 px-3 py-1.5 font-medium text-white enabled:hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Resetting…" : DEMO ? "Unavailable in demo" : `Reset ${targetLabel} to ${amountOk ? usd(n, 0) : "…"}`}
          </button>
        </form>
      )}
    </Panel>
  );
}
