import { DEMO } from "@/lib/config";

export function SimBanner() {
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-200">
      <strong className="font-semibold">SIMULATED WALLET.</strong> Paper trading only: no real wallet, keys, or transactions. Prices are real market data; fills and fees are estimates.
      {DEMO && <span className="ml-2 rounded bg-amber-400/20 px-1.5 py-0.5 text-xs font-semibold">DEMO DATA: set NEXT_PUBLIC_API_URL to connect the Worker</span>}
    </div>
  );
}
