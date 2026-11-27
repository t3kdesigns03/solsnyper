import type { Config } from "../config";
import type { DiscoveredMint, MarketSnapshot, OpenPosition, PendingOrder } from "../types";
import { type BuyFill, type MarketAtFill, markToMarket, type SellFill, simulateBuy, simulateSell, txFeeSol } from "./broker";
import { evaluateExit } from "./exits";
import { evaluateEntry, poolRoundTripCostPct } from "./filters";
import { scoreCandidate } from "./scoring";

// The whole trading brain for one tick, as a PURE function:
//   (state before, market data, time, config) -> plan of what to write.
// engine.ts does the I/O around it. Tests call this directly with fixtures.
//
// Order of work each tick:
//   1. Open positions: fill due sell orders, re-price the rest, check exit rules.
//   2. Fill due buy orders (at THIS tick's price, not the price that triggered them).
//   3. Filter + rank new candidates; place buy orders (or buy now if fillDelayTicks = 0).
//   4. Equity = cash + open positions valued net of estimated exit costs.

export interface TickInput {
  now: number;
  cfg: Config;
  cashUsd: number;
  solPriceUsd: number;
  open: OpenPosition[];
  pending?: PendingOrder[];
  discovered: DiscoveredMint[];
  snapshots: Map<string, MarketSnapshot>;
  recentlyTraded: Map<string, number>; // mint -> last trade ms
  recentSymbols?: Map<string, number>; // UPPERCASE symbol -> last buy ms
  buysLastHour?: number; // buys filled in the last 60 minutes
}

export interface PlannedBuy {
  snap: MarketSnapshot;
  score: number | null;
  fill: BuyFill;
  signalPrice: number; // price when the buy was decided
  reason: string;
}

export interface PlannedSell {
  pos: OpenPosition;
  rule: string;
  reason: string;
  fill: SellFill;
  signalPrice: number; // price when the exit was decided
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
  action: "buy" | "reject" | "skip" | "sell" | "order" | "cancel";
  reason: string;
  score: number | null;
}

export type NewOrder = Omit<PendingOrder, "id">;

export interface TickPlan {
  sells: PlannedSell[];
  updates: PositionUpdate[];
  buys: PlannedBuy[];
  newOrders: NewOrder[];
  closedOrders: { id: number; outcome: "filled" | "cancelled"; note: string }[];
  waitingOrders: { id: number; ticksWaited: number }[];
  candidates: CandidateRow[];
  decisions: Decision[];
  cashAfter: number;
  equityAfter: number;
  openAfter: number;
}

const pctMove = (fill: number, signal: number) => {
  const x = signal > 0 ? fill / signal - 1 : 0;
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
};

export function planTick(input: TickInput): TickPlan {
  const { now, cfg, snapshots } = input;
  const costs = cfg.costs;
  const delay = Math.max(0, Math.floor(costs.fillDelayTicks));
  const sol = input.solPriceUsd > 0 ? input.solPriceUsd : costs.fallbackSolPriceUsd;
  const pending = input.pending ?? [];
  const due = (o: PendingOrder) => o.ticks_waited + 1 >= delay;

  let cash = input.cashUsd;
  const sells: PlannedSell[] = [];
  const updates: PositionUpdate[] = [];
  const buys: PlannedBuy[] = [];
  const newOrders: NewOrder[] = [];
  const closedOrders: TickPlan["closedOrders"] = [];
  const waitingOrders: TickPlan["waitingOrders"] = [];
  const decisions: Decision[] = [];
  const stillOpen: { pos: OpenPosition; m: MarketAtFill }[] = [];
  const recentlyTraded = new Map(input.recentlyTraded);

  const marketFor = (pos: OpenPosition, snap: MarketSnapshot | undefined, price: number): MarketAtFill => ({
    price,
    // Snapshot liquidity if we have one; otherwise the last we saw.
    liquidityUsd: snap ? snap.liquidityUsd : pos.current_liquidity ?? pos.entry_liquidity,
    dexId: pos.dex_id ?? snap?.dexId ?? null,
    solPriceUsd: sol,
  });

  const sell = (pos: OpenPosition, m: MarketAtFill, rule: string, reason: string, signalPrice: number) => {
    const fill = simulateSell(pos, m, costs);
    cash += fill.cashIn;
    sells.push({ pos, rule, reason, fill, signalPrice });
    decisions.push({
      mint: pos.mint,
      action: "sell",
      reason: `${rule}: ${reason} · filled @ ${fill.fillPrice.toPrecision(4)} (${pctMove(fill.fillPrice, signalPrice)} vs signal) · costs $${fill.costs.totalUsd.toFixed(2)}`,
      score: null,
    });
    recentlyTraded.set(pos.mint, now);
  };

  // 1) Open positions.
  const sellOrders = new Map(pending.filter((o) => o.side === "sell" && o.position_id !== null).map((o) => [o.position_id!, o]));
  const openIds = new Set(input.open.map((p) => p.id));
  for (const o of pending) {
    if (o.side === "sell" && (o.position_id === null || !openIds.has(o.position_id))) {
      closedOrders.push({ id: o.id, outcome: "cancelled", note: "position no longer open" });
    }
  }

  for (const pos of input.open) {
    const snap = snapshots.get(pos.mint);
    const price = snap && snap.priceUsd > 0 ? snap.priceUsd : null;
    const lastPrice = price ?? pos.current_price;
    const m = marketFor(pos, snap, lastPrice);
    const order = sellOrders.get(pos.id);

    if (order) {
      // A sell was decided earlier: fill it now if due. With no price, wait a
      // few ticks before giving up and closing at the last seen price.
      const ready = due(order) && (price !== null || order.ticks_waited + 1 >= cfg.exits.maxMissedUpdates);
      if (ready) {
        const [rule, ...rest] = order.reason.split(": ");
        sell(pos, m, rule, rest.join(": ") || order.reason, order.signal_price);
        closedOrders.push({ id: order.id, outcome: "filled", note: "" });
        continue;
      }
      waitingOrders.push({ id: order.id, ticksWaited: order.ticks_waited + 1 });
    } else {
      const exit = evaluateExit(pos, { now, cfg, price, liquidity: snap ? snap.liquidityUsd : null });
      if (exit && delay === 0) {
        sell(pos, m, exit.rule, exit.reason, lastPrice);
        continue;
      }
      if (exit) {
        newOrders.push({
          side: "sell", mint: pos.mint, symbol: pos.symbol, position_id: pos.id, signal_price: lastPrice,
          signal_time: now, reason: `${exit.rule}: ${exit.reason}`, score: null, ticks_waited: 0,
        });
        decisions.push({ mint: pos.mint, action: "order", reason: `sell order (${exit.rule}: ${exit.reason}) · fills next tick`, score: null });
      }
    }

    const mtm = markToMarket(pos, m, costs);
    updates.push({
      id: pos.id,
      price: lastPrice,
      liquidity: snap ? snap.liquidityUsd : pos.current_liquidity,
      peak: Math.max(pos.peak_price, lastPrice),
      unrealizedPnl: mtm.unrealizedPnl,
      missedUpdates: price === null ? pos.missed_updates + 1 : 0,
    });
    stillOpen.push({ pos, m });
  }

  // 2) Due buy orders fill at this tick's price. Waiting ones hold a slot and cash.
  const held = new Set(stillOpen.map((o) => o.pos.mint));
  let slots = cfg.wallet.maxOpenPositions - stillOpen.length;
  let reserved = 0; // cash earmarked for buy orders that haven't filled yet
  const estCashOut = cfg.wallet.buySizeUsd + txFeeSol(costs) * sol;
  const maxRt = cfg.costControl.maxRoundTripCostPct;

  for (const o of pending.filter((p) => p.side === "buy")) {
    if (!due(o)) {
      waitingOrders.push({ id: o.id, ticksWaited: o.ticks_waited + 1 });
      held.add(o.mint);
      slots -= 1;
      reserved += estCashOut;
      continue;
    }
    const snap = snapshots.get(o.mint);
    let cancel: string | null = null;
    if (!snap || snap.priceUsd <= 0) cancel = "no price at fill time";
    else if (held.has(o.mint)) cancel = "already holding this mint";
    else if (slots <= 0) cancel = `max ${cfg.wallet.maxOpenPositions} open positions`;
    else {
      // Re-check the pool before filling: if it thinned out or was drained since
      // the signal, a real bot would see a terrible quote and not send the swap.
      const rt = poolRoundTripCostPct(snap, cfg, sol);
      if (rt > maxRt) cancel = `pool too thin at fill: round trip ${(rt * 100).toFixed(1)}% > ${(maxRt * 100).toFixed(1)}% (liquidity ${Math.round(snap.liquidityUsd).toLocaleString("en-US")})`;
    }
    const fill = snap && !cancel ? simulateBuy(cfg.wallet.buySizeUsd, { price: snap.priceUsd, liquidityUsd: snap.liquidityUsd, dexId: snap.dexId, solPriceUsd: sol }, costs) : null;
    if (fill && cash < fill.cashOut) cancel = `insufficient cash ($${cash.toFixed(2)})`;
    if (cancel || !snap || !fill) {
      closedOrders.push({ id: o.id, outcome: "cancelled", note: cancel ?? "no fill" });
      decisions.push({ mint: o.mint, action: "cancel", reason: `buy order cancelled: ${cancel}`, score: o.score });
      continue;
    }
    cash -= fill.cashOut;
    slots -= 1;
    held.add(o.mint);
    recentlyTraded.set(o.mint, now);
    buys.push({ snap, score: o.score, fill, signalPrice: o.signal_price, reason: o.reason });
    closedOrders.push({ id: o.id, outcome: "filled", note: "" });
    decisions.push({
      mint: o.mint,
      action: "buy",
      reason: `filled $${cfg.wallet.buySizeUsd} buy @ ${fill.fillPrice.toPrecision(4)} (${pctMove(fill.fillPrice, o.signal_price)} vs signal ${o.signal_price.toPrecision(4)}) · costs $${fill.costs.totalUsd.toFixed(2)}`,
      score: o.score,
    });
  }

  // 3) Filter discovered mints (deduped, first source wins).
  const recentSymbols = new Map(input.recentSymbols ?? []);
  for (const o of pending) if (o.side === "buy") recentSymbols.set(o.symbol.toUpperCase(), o.signal_time);
  // Rolling-hour buy count: filled buys + every buy order still pending.
  let hourBuys = (input.buysLastHour ?? 0) + pending.filter((o) => o.side === "buy").length;
  const seen = new Set<string>();
  const candidates: CandidateRow[] = [];
  const passed: { row: CandidateRow; snap: MarketSnapshot; score: number }[] = [];

  for (const d of input.discovered) {
    if (seen.has(d.mint)) continue;
    seen.add(d.mint);
    const snap = snapshots.get(d.mint) ?? null;
    if (!snap) {
      candidates.push({ mint: d.mint, symbol: d.hintSymbol ?? "?", source: d.source, snap: null, passed: false, reason: "no Solana pool with price data yet", score: null });
      continue;
    }
    const res = evaluateEntry(snap, { now, cfg, held, recentlyTraded, recentSymbols, solPriceUsd: sol });
    const score = scoreCandidate(snap);
    const row: CandidateRow = { mint: d.mint, symbol: snap.symbol, source: d.source, snap, passed: res.passed, reason: res.reason, score };
    candidates.push(row);
    if (res.passed) passed.push({ row, snap, score });
  }

  // Rank survivors; ties broken by mint for determinism.
  passed.sort((a, b) => b.score - a.score || a.snap.mint.localeCompare(b.snap.mint));
  let signals = 0;
  const boughtThisTick = new Set<string>();
  const symbolTaken = (sym: string) => cfg.costControl.symbolCooldownMinutes > 0 && boughtThisTick.has(sym.toUpperCase());

  for (const c of passed) {
    const m: MarketAtFill = { price: c.snap.priceUsd, liquidityUsd: c.snap.liquidityUsd, dexId: c.snap.dexId, solPriceUsd: sol };
    const fill = simulateBuy(cfg.wallet.buySizeUsd, m, costs);
    let skip: string | null = null;
    if (signals >= cfg.wallet.maxBuysPerTick) skip = `max ${cfg.wallet.maxBuysPerTick} buys per tick`;
    else if (slots <= 0) skip = `max ${cfg.wallet.maxOpenPositions} open positions`;
    else if (hourBuys >= cfg.costControl.maxBuysPerHour) skip = `max ${cfg.costControl.maxBuysPerHour} buys per hour`;
    else if (symbolTaken(c.snap.symbol)) skip = `symbol ${c.snap.symbol} already bought this tick under another mint`;
    else if (cash - reserved < fill.cashOut) skip = `insufficient cash ($${(cash - reserved).toFixed(2)} free)`;

    if (skip) {
      c.row.reason = `passed, skipped: ${skip}`;
      decisions.push({ mint: c.snap.mint, action: "skip", reason: skip, score: c.score });
      continue;
    }
    signals += 1;
    hourBuys += 1;
    slots -= 1;
    held.add(c.snap.mint);
    boughtThisTick.add(c.snap.symbol.toUpperCase());
    const why = `score ${c.score}`;
    if (delay === 0) {
      cash -= fill.cashOut;
      recentlyTraded.set(c.snap.mint, now);
      buys.push({ snap: c.snap, score: c.score, fill, signalPrice: c.snap.priceUsd, reason: why });
      c.row.reason = "bought";
      decisions.push({ mint: c.snap.mint, action: "buy", reason: `passed all filters, $${cfg.wallet.buySizeUsd} buy @ ${fill.fillPrice.toPrecision(4)} · costs $${fill.costs.totalUsd.toFixed(2)}`, score: c.score });
    } else {
      reserved += fill.cashOut;
      newOrders.push({
        side: "buy", mint: c.snap.mint, symbol: c.snap.symbol, position_id: null, signal_price: c.snap.priceUsd,
        signal_time: now, reason: why, score: c.score, ticks_waited: 0,
      });
      c.row.reason = delay === 1 ? "buy order placed (fills next tick)" : `buy order placed (fills in ${delay} ticks)`;
      decisions.push({ mint: c.snap.mint, action: "order", reason: `passed all filters, $${cfg.wallet.buySizeUsd} buy order @ signal ${c.snap.priceUsd.toPrecision(4)}`, score: c.score });
    }
  }

  for (const c of candidates) {
    if (!c.passed) decisions.push({ mint: c.mint, action: "reject", reason: c.reason, score: c.score });
  }

  // 4) Equity = cash + open positions valued net of estimated exit costs.
  let equity = cash;
  for (const o of stillOpen) equity += markToMarket(o.pos, o.m, costs).valueUsd;
  for (const b of buys) {
    const m: MarketAtFill = { price: b.snap.priceUsd, liquidityUsd: b.snap.liquidityUsd, dexId: b.snap.dexId, solPriceUsd: sol };
    equity += markToMarket({ quantity: b.fill.quantity, size_usd: cfg.wallet.buySizeUsd, entry_fee_usd: b.fill.cashOut - cfg.wallet.buySizeUsd }, m, costs).valueUsd;
  }

  return {
    sells,
    updates,
    buys,
    newOrders,
    closedOrders,
    waitingOrders,
    candidates,
    decisions,
    cashAfter: cash,
    equityAfter: equity,
    openAfter: stillOpen.length + buys.length,
  };
}
