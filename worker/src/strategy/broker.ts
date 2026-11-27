import type { Config } from "../config";

// Paper broker: pure fill + accounting math. No I/O, no randomness.
//
// Every swap pays three costs (see CONFIG.costs):
//   1. DEX fee      - % of the swap, depends on the pool's DEX
//   2. network fee  - (base + priority) SOL per transaction, in USD at the SOL price
//   3. slippage     - constant-product price impact + a fixed buffer
//
// Buy of S USD at observed price p into a pool with L USD liquidity:
//   dexFee   = S * f
//   swap     = S - dexFee                          (what actually enters the pool)
//   impact   = swap / (L/2 + swap)
//   received = swap * (1 - impact) * (1 - extra)   (token value at price p)
//   quantity = received / p,  fill price = swap / quantity  (> p)
//   cash out = S + networkFee
// Sell of q tokens at observed price p:
//   value    = q * p
//   impact   = value / (L/2 + value)
//   received = value * (1 - impact) * (1 - extra),  fill price = received / q  (< p)
//   cash in  = received - received * f - networkFee
// P&L = cash in - cash out (both legs, every cost included).

export type Costs = Config["costs"];

export interface CostBreakdown {
  dexFeeUsd: number;
  networkFeeUsd: number;
  slippageUsd: number;
  totalUsd: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");

/** DEX fee for a pool's dexId: exact match, then longest prefix match, then `default`. */
export function dexFeePct(dexId: string | null | undefined, costs: Costs): number {
  const table = costs.dexFeePct;
  const fallback = table.default ?? 0.003;
  if (!dexId) return fallback;
  const id = norm(dexId);
  let best: { len: number; fee: number } | null = null;
  for (const [k, fee] of Object.entries(table)) {
    if (k === "default") continue;
    const key = norm(k);
    if (key === id) return fee;
    if (id.startsWith(key) && (!best || key.length > best.len)) best = { len: key.length, fee };
  }
  return best ? best.fee : fallback;
}

/** Constant-product price impact of swapping `sizeUsd` into a pool holding `liquidityUsd` (both sides). */
export function priceImpact(sizeUsd: number, liquidityUsd: number): number {
  if (sizeUsd <= 0) return 0;
  const half = Math.max(0, liquidityUsd) / 2;
  return sizeUsd / (half + sizeUsd);
}

/** SOL paid per transaction: base fee + the active priority fee (normal or patient). */
export function txFeeSol(costs: Costs): number {
  return costs.networkFeeSol + (costs.usePatientPriorityFee ? costs.patientPriorityFeeSol : costs.priorityFeeSol);
}

export function networkFeeUsd(solPriceUsd: number, costs: Costs): number {
  return txFeeSol(costs) * solPriceUsd;
}

export interface MarketAtFill {
  price: number; // observed price this tick
  liquidityUsd: number; // observed (or last known) pool liquidity
  dexId: string | null;
  solPriceUsd: number;
}

export interface BuyFill {
  signalPrice: number; // price we observed when filling
  fillPrice: number; // effective price paid per token (after slippage, before DEX fee)
  quantity: number;
  cashOut: number; // total cash leaving the wallet
  costs: CostBreakdown;
}

export function simulateBuy(sizeUsd: number, m: MarketAtFill, costs: Costs): BuyFill {
  const f = dexFeePct(m.dexId, costs);
  const dexFee = sizeUsd * f;
  const swap = sizeUsd - dexFee;
  const impact = priceImpact(swap, m.liquidityUsd);
  const received = swap * (1 - impact) * (1 - costs.extraSlippagePct);
  const quantity = m.price > 0 ? received / m.price : 0;
  const net = networkFeeUsd(m.solPriceUsd, costs);
  const slippage = swap - received;
  return {
    signalPrice: m.price,
    fillPrice: quantity > 0 ? swap / quantity : m.price,
    quantity,
    cashOut: sizeUsd + net,
    costs: { dexFeeUsd: dexFee, networkFeeUsd: net, slippageUsd: slippage, totalUsd: dexFee + net + slippage },
  };
}

/** The parts of a position the sell math needs. `entry_fee_usd` = cash spent beyond `size_usd` on entry. */
export interface PositionCost {
  quantity: number;
  size_usd: number;
  entry_fee_usd: number;
}

export interface SellFill {
  signalPrice: number;
  fillPrice: number; // effective price received per token (after slippage, before DEX fee)
  grossUsd: number; // quantity * observed price
  receivedUsd: number; // USD out of the pool before the DEX fee
  cashIn: number; // net cash returning to the wallet
  pnlUsd: number; // net of both legs' costs
  costs: CostBreakdown;
}

export function simulateSell(pos: PositionCost, m: MarketAtFill, costs: Costs): SellFill {
  const f = dexFeePct(m.dexId, costs);
  const value = pos.quantity * Math.max(0, m.price);
  const impact = priceImpact(value, m.liquidityUsd);
  const received = value * (1 - impact) * (1 - costs.extraSlippagePct);
  const dexFee = received * f;
  const net = networkFeeUsd(m.solPriceUsd, costs);
  const cashIn = received - dexFee - net;
  const slippage = value - received;
  return {
    signalPrice: m.price,
    fillPrice: pos.quantity > 0 ? received / pos.quantity : m.price,
    grossUsd: value,
    receivedUsd: received,
    cashIn,
    pnlUsd: cashIn - pos.size_usd - pos.entry_fee_usd,
    costs: { dexFeeUsd: dexFee, networkFeeUsd: net, slippageUsd: slippage, totalUsd: dexFee + net + slippage },
  };
}

/**
 * Value of a position if sold now (net of every estimated exit cost) and its
 * unrealized P&L. A position is never worth less than zero: you can just not sell.
 */
export function markToMarket(pos: PositionCost, m: MarketAtFill, costs: Costs) {
  const value = Math.max(0, simulateSell(pos, m, costs).cashIn);
  return { valueUsd: value, unrealizedPnl: value - pos.size_usd - pos.entry_fee_usd };
}

/** Cost of buying and immediately selling at an unchanged price: the "do nothing" loss per round trip. */
export function roundTripCost(sizeUsd: number, m: MarketAtFill, costs: Costs) {
  const b = simulateBuy(sizeUsd, m, costs);
  const s = simulateSell({ quantity: b.quantity, size_usd: sizeUsd, entry_fee_usd: b.cashOut - sizeUsd }, m, costs);
  return {
    totalUsd: -s.pnlUsd,
    pctOfSize: -s.pnlUsd / sizeUsd,
    dexFeeUsd: b.costs.dexFeeUsd + s.costs.dexFeeUsd,
    networkFeeUsd: b.costs.networkFeeUsd + s.costs.networkFeeUsd,
    slippageUsd: b.costs.slippageUsd + s.costs.slippageUsd,
  };
}

/** Old model, kept only so the README/report can compare: flat 0.8% round trip. */
export const LEGACY_ROUND_TRIP_PCT = 0.008;
