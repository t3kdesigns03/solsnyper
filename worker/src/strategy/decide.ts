import type { Config } from "../config";
import type { DiscoveredMint, MarketSnapshot, OpenPosition } from "../types";
import { markToMarket, simulateBuy, simulateSell } from "./broker";
import { evaluateExit } from "./exits";
import { evaluateEntry } from "./filters";
import { scoreCandidate } from "./scoring";

// The whole trading brain for one tick, as a PURE function:
//   (state before, market data, time, config) -> plan of what to write.
// engine.ts does the I/O around it. Tests call this directly with fixtures.

export interface TickInput {
  now: number;
  cfg: Config;
  cashUsd: number;
  open: OpenPosition[];
  discovered: DiscoveredMint[];
  snapshots: Map<string, MarketSnapshot>;
  recentlyTraded: Map<string, number>; // mint -> last exit ms
}

export interface PlannedBuy {
  snap: MarketSnapshot;
  score: number;
  quantity: number;
  feeUsd: number;
  cashOut: number;
}

export interface PlannedSell {
  pos: OpenPosition;
  price: number;
  rule: string;
  reason: string;
  feeUsd: number;
  cashIn: number;
  pnlUsd: number;
}

export interface PositionUpdate {
  id: number;
  price: number;
  liquidity: number | null;
  peak: number;
  unrealizedPnl: number;
  missedUpdates: number;
}

export interface CandidateRow {
  mint: string;
  symbol: string;
  source: string;
  snap: MarketSnapshot | null;
  passed: boolean;
  reason: string;
  score: number | null;
}

export interface Decision {
  mint: string;
  action: "buy" | "reject" | "skip" | "sell";
  reason: string;
  score: number | null;
}

export interface TickPlan {
  sells: PlannedSell[];
  updates: PositionUpdate[];
  buys: PlannedBuy[];
  candidates: CandidateRow[];
  decisions: Decision[];
  cashAfter: number;
  equityAfter: number;
  openAfter: number;
}

export function planTick(input: TickInput): TickPlan {
  const { now, cfg, snapshots } = input;
  const fee = cfg.fees.roundTripPct;
  let cash = input.cashUsd;
  const sells: PlannedSell[] = [];
  const updates: PositionUpdate[] = [];
  const decisions: Decision[] = [];
  const stillOpen: { pos: OpenPosition; price: number }[] = [];
  const recentlyTraded = new Map(input.recentlyTraded);

  // 1) Re-price open positions and check exits.
  for (const pos of input.open) {
    const snap = snapshots.get(pos.mint);
    const price = snap && snap.priceUsd > 0 ? snap.priceUsd : null;
    const liquidity = snap ? snap.liquidityUsd : null;
    const exit = evaluateExit(pos, { now, cfg, price, liquidity });
    const fillPrice = price ?? pos.current_price;

    if (exit) {
      const s = simulateSell(pos, fillPrice, fee);
      cash += s.cashIn;
      sells.push({ pos, price: fillPrice, rule: exit.rule, reason: exit.reason, feeUsd: s.feeUsd, cashIn: s.cashIn, pnlUsd: s.pnlUsd });
      decisions.push({ mint: pos.mint, action: "sell", reason: `${exit.rule}: ${exit.reason}`, score: null });
      recentlyTraded.set(pos.mint, now);
    } else {
      const m = markToMarket(pos, fillPrice, fee);
      updates.push({
        id: pos.id,
        price: fillPrice,
        liquidity: liquidity ?? pos.current_liquidity,
        peak: Math.max(pos.peak_price, fillPrice),
        unrealizedPnl: m.unrealizedPnl,
        missedUpdates: price === null ? pos.missed_updates + 1 : 0,
      });
      stillOpen.push({ pos, price: fillPrice });
    }
  }

  // 2) Filter discovered mints (deduped, first source wins).
  const held = new Set(stillOpen.map((o) => o.pos.mint));
  const seen = new Set<string>();
  const candidates: CandidateRow[] = [];
  const passed: { row: CandidateRow; snap: MarketSnapshot; score: number }[] = [];

  for (const d of input.discovered) {
    if (seen.has(d.mint)) continue;
    seen.add(d.mint);
    const snap = snapshots.get(d.mint) ?? null;
    if (!snap) {
      candidates.push({ mint: d.mint, symbol: d.hintSymbol ?? "?", source: d.source, snap: null, passed: false, reason: "no Solana pair on DexScreener yet", score: null });
      continue;
    }
    const res = evaluateEntry(snap, { now, cfg, held, recentlyTraded });
    const score = scoreCandidate(snap);
    const row: CandidateRow = { mint: d.mint, symbol: snap.symbol, source: d.source, snap, passed: res.passed, reason: res.reason, score };
    candidates.push(row);
    if (res.passed) passed.push({ row, snap, score });
  }

  // 3) Rank survivors and buy what cash + slots allow. Ties broken by mint for determinism.
  passed.sort((a, b) => b.score - a.score || a.snap.mint.localeCompare(b.snap.mint));
  const buys: PlannedBuy[] = [];
  let slots = cfg.wallet.maxOpenPositions - stillOpen.length;

  for (const c of passed) {
    const b = simulateBuy(cfg.wallet.buySizeUsd, c.snap.priceUsd, fee);
    let skip: string | null = null;
    if (buys.length >= cfg.wallet.maxBuysPerTick) skip = `max ${cfg.wallet.maxBuysPerTick} buys per tick`;
    else if (slots <= 0) skip = `max ${cfg.wallet.maxOpenPositions} open positions`;
    else if (cash < b.cashOut) skip = `insufficient cash ($${cash.toFixed(2)})`;

    if (skip) {
      c.row.reason = `passed, skipped: ${skip}`;
      decisions.push({ mint: c.snap.mint, action: "skip", reason: skip, score: c.score });
      continue;
    }
    cash -= b.cashOut;
    slots -= 1;
    buys.push({ snap: c.snap, score: c.score, ...b });
    c.row.reason = "bought";
    decisions.push({ mint: c.snap.mint, action: "buy", reason: `passed all filters, $${cfg.wallet.buySizeUsd} paper buy @ ${c.snap.priceUsd}`, score: c.score });
  }

  for (const c of candidates) {
    if (!c.passed) decisions.push({ mint: c.mint, action: "reject", reason: c.reason, score: c.score });
  }

  // 4) Equity = cash + open positions valued net of exit fee.
  let equity = cash;
  for (const o of stillOpen) equity += markToMarket(o.pos, o.price, fee).valueUsd;
  for (const b of buys) equity += markToMarket({ quantity: b.quantity, size_usd: cfg.wallet.buySizeUsd, entry_fee_usd: b.feeUsd }, b.snap.priceUsd, fee).valueUsd;

  return {
    sells,
    updates,
    buys,
    candidates,
    decisions,
    cashAfter: cash,
    equityAfter: equity,
    openAfter: stillOpen.length + buys.length,
  };
}
