export const usd = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const signedUsd = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;

export const compactUsd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Meme-coin prices can be 0.00000123; show 4 significant digits. */
export const price = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
};

export const pct = (n: number) => {
  const s = Math.abs(n * 100).toFixed(1);
  return `${s === "0.0" ? "" : n >= 0 ? "+" : "−"}${s}%`;
};

export const shortMint = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

export function ago(ts: number | null | undefined, now = Date.now()) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

export const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const pnlClass = (n: number | null | undefined) => (!n ? "text-zinc-300" : n > 0 ? "text-emerald-400" : "text-rose-400");
