// Paper broker: pure fill + accounting math. No I/O, no randomness.
// Fees: half the round-trip on each leg (0.4% + 0.4% = 0.8%).

export function legFeePct(roundTripPct: number): number {
  return roundTripPct / 2;
}

export function simulateBuy(sizeUsd: number, price: number, roundTripPct: number) {
  const fee = sizeUsd * legFeePct(roundTripPct);
  return {
    quantity: sizeUsd / price,
    feeUsd: fee,
    cashOut: sizeUsd + fee,
  };
}

export function simulateSell(
  pos: { quantity: number; size_usd: number; entry_fee_usd: number },
  price: number,
  roundTripPct: number,
) {
  const gross = pos.quantity * price;
  const fee = gross * legFeePct(roundTripPct);
  const cashIn = gross - fee;
  return {
    grossUsd: gross,
    feeUsd: fee,
    cashIn,
    pnlUsd: cashIn - pos.size_usd - pos.entry_fee_usd, // net of both legs
  };
}

/** Value of a position if sold now (net of estimated exit fee), and its unrealized PnL. */
export function markToMarket(
  pos: { quantity: number; size_usd: number; entry_fee_usd: number },
  price: number,
  roundTripPct: number,
) {
  const s = simulateSell(pos, price, roundTripPct);
  return { valueUsd: s.cashIn, unrealizedPnl: s.pnlUsd };
}
