import { CandidatesFeed } from "@/components/CandidatesFeed";
import { ClosedTrades } from "@/components/ClosedTrades";
import { CostSettings } from "@/components/CostSettings";
import { DecisionLog } from "@/components/DecisionLog";
import { EquityChart } from "@/components/EquityChart";
import { PositionsTable } from "@/components/PositionsTable";
import { ResetWallet } from "@/components/ResetWallet";
import { SimBanner } from "@/components/SimBanner";
import { SummaryCards } from "@/components/SummaryCards";

export default function Dashboard() {
  return (
    <>
      <SimBanner />
      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-5">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-lg font-semibold text-zinc-100">
            SolSnyper <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 align-middle text-xs font-medium text-zinc-400">paper</span>
          </h1>
          <span className="text-xs text-zinc-500">$100–250 buys · −8% stop · +25% TP · 12m max hold · real DEX fees, gas &amp; slippage</span>
        </div>
        <SummaryCards />
        <div className="grid gap-4 xl:grid-cols-2">
          <EquityChart />
          <PositionsTable />
        </div>
        <CandidatesFeed />
        <CostSettings />
        <div className="grid gap-4 xl:grid-cols-2">
          <ClosedTrades />
          <DecisionLog />
        </div>
        <ResetWallet />
      </main>
    </>
  );
}
