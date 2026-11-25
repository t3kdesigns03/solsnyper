// All strategy knobs live here. Change a number, redeploy, done.
// Every value is deterministic: same inputs + same config => same decisions.

export const CONFIG = {
  tickIntervalMs: 45_000,

  wallet: {
    startingEquityUsd: 1000,
    buySizeUsd: 20,
    maxOpenPositions: 10,
    maxBuysPerTick: 3,
  },

  fees: {
    // 0.8% round trip, charged as 0.4% on the buy and 0.4% on the sell.
    roundTripPct: 0.008,
  },

  filters: {
    maxAgeMinutes: 60, // "very new"
    minLiquidityUsd: 20_000,
    minVolumeH1Usd: 5_000,
    minTxnsH1: 30,
    minSellsH1: 3, // honeypot hint: lots of buys, nobody can sell
    maxFdvToLiquidity: 40, // thin liquidity vs. valuation = easy to rug
    maxPriceChangeM5Pct: 150, // don't chase a vertical candle
    minPriceChangeM5Pct: -25, // don't catch a falling knife
    reentryCooldownMinutes: 120, // never re-buy a mint we traded recently
  },

  exits: {
    hardStopPct: -0.08,
    takeProfitPct: 0.25,
    maxHoldMinutes: 12,
    // Give-back: once the position has been up at least `armAtGainPct`,
    // exit if it has surrendered `givebackFraction` of its peak gain.
    givebackArmAtGainPct: 0.1,
    givebackFraction: 0.6,
    // Rug-ish signal: liquidity fell below this share of entry liquidity.
    liquidityCollapseFraction: 0.4,
    // Price feed lost for this many consecutive ticks => close at last price.
    maxMissedUpdates: 4,
  },

  retention: {
    decisionsDays: 3,
    candidatesHours: 6,
    // Only log a reject again if its reason changed (avoids ~100k identical rows/day).
    logUnchangedRejects: false,
  },
} as const;

export type Config = typeof CONFIG;
