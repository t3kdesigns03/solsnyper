import type { ReactNode } from "react";

export function Panel({ title, right, children, className = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-zinc-800 bg-zinc-900/60 ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-200">{title}</h2>
        {right && <div className="text-xs text-zinc-500">{right}</div>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

export function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={`whitespace-nowrap px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

export function Td({ children, right, className = "" }: { children: ReactNode; right?: boolean; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-1.5 ${right ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>;
}

export function Empty({ children, cols }: { children: ReactNode; cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-sm text-zinc-500">
        {children}
      </td>
    </tr>
  );
}

const BADGE: Record<string, string> = {
  buy: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  sell: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  reject: "bg-zinc-500/15 text-zinc-400 ring-zinc-500/30",
  skip: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  error: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  pass: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  fail: "bg-rose-500/10 text-rose-300 ring-rose-500/25",
};

export function Badge({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium uppercase ring-1 ring-inset ${BADGE[kind] ?? BADGE.reject}`}>{children ?? kind}</span>;
}

export function MintLink({ mint, symbol }: { mint: string; symbol: string }) {
  return (
    <a href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer" className="group">
      <span className="font-medium text-zinc-100 group-hover:text-violet-300">{symbol}</span>
      <span className="ml-1.5 font-mono text-[11px] text-zinc-500">{mint.slice(0, 4)}…{mint.slice(-4)}</span>
    </a>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="border-b border-rose-900/50 bg-rose-950/40 px-4 py-1.5 text-xs text-rose-300">Couldn&apos;t refresh: {error}</div>;
}
