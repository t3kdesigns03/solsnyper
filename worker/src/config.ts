// All strategy knobs live here. Change a number, `npm run deploy`, done.
// Every value is deterministic: same inputs + same config => same decisions.
// Percentages are fractions: 0.01 = 1%. Money is USD unless the name says SOL.
// The README "Tuning" section explains each knob and what moving it does.

export const CONFIG = {
  tickIntervalMs: 45_000, // how often the bot looks at the market (Durable Object alarm)

  wallet: {
    startingEquityUsd: 10_000, // paper bankroll after /api/reset (the dashboard can pass its own)
    // Trade size. Every buy is at least buySizeUsd (network fee extra). In deep
    // pools it scales up toward maxBuySizeUsd, but never above maxPoolSharePct of
    // the pool's liquidity and only while the round trip stays under
    // costControl.maxRoundTripCostPct. Set maxBuySizeUsd = buySizeUsd for fixed size.
    buySizeUsd: 100,
    maxBuySizeUsd: 250,
    maxPoolSharePct: 0.005, // 0.5% of liquidity: $250 needs a $50k+ pool
    maxOpenPositions: 10, // never hold more than this many tokens at once
    maxBuysPerTick: 3, // at most this many new buys per tick (best scores first)
  },

  // ── Trading costs ──────────────────────────────────────────────────────────
  // Every simulated swap pays: DEX fee + network fee + slippage. Net P&L
  // includes all of it, and the dashboard shows each part per trade.
  costs: {
    // DEX swap fee, by the pool's dexId (as reported by DexScreener/GeckoTerminal).
    // Matched case-insensitively ignoring "-"/"_", exact first, then by prefix
    // (so "raydium-clmm" uses "raydium"). Unknown DEXes use `default`.
    dexFeePct: {
      pumpfun: 0.01, // pump.fun bonding curve: 1% per trade
      pumpswap: 0.003, // PumpSwap AMM: 0.25% pool + 0.05% creator
      raydium: 0.0025, // Raydium AMM v4: 0.25%
      meteora: 0.003, // varies by pool; 0.3% is a typical small-cap pool
      orca: 0.003, // Whirlpools: varies by tier; 0.3% typical
      default: 0.003,
    } as Record<string, number>,

    // Solana fees per transaction, in SOL, converted with the live SOL price.
    networkFeeSol: 0.000005, // base fee (5,000 lamports per signature)
    priorityFeeSol: 0.0005, // priority fee / tip so the swap lands quickly on busy blocks
    // "Patient" mode pays a smaller priority fee. Cheaper, but in real life the
    // swap can land later (worse price) or not at all on busy blocks; this sim
    // does NOT model that risk, so treat its savings as a best case.
    usePatientPriorityFee: false,
    patientPriorityFeeSol: 0.0001,
    // SOL price used only if no live or previously stored SOL price exists.
    fallbackSolPriceUsd: 150,

    // Slippage = constant-product price impact + a fixed buffer.
    //   impact = size / (liquidityUsd / 2 + size)   (liquidity is both sides; half is the side you swap into)
    // Buys fill ABOVE the observed price, sells BELOW it.
    extraSlippagePct: 0.005, // MEV / sandwiches / price moving inside the block

    // Orders fill at the observed price this many ticks AFTER the decision,
    // so the bot can't buy at exactly the price that triggered the buy.
    // 1 = next tick (~45s later, realistic for a bot polling APIs). 0 = instant.
    fillDelayTicks: 1,
  },

  // ── Cost control: strategy rules that avoid expensive or pointless trades ──
  // Each shows up as a reject/skip/cancel reason in the decision log.
  costControl: {
    // Skip a buy if a $buySizeUsd round trip in THIS pool (its DEX fee, its
    // liquidity, current gas) would cost more than this share of the trade.
    // Also re-checked when a delayed order fills: if the pool got thinner (or
    // was drained) in the meantime, the order is cancelled instead of filled.
    maxRoundTripCostPct: 0.03,
    // Skip a buy unless takeProfitPct is at least this many times the pool's
    // round-trip cost, so a winning trade isn't mostly eaten by costs.
    minEdgeMultiple: 2,
    // Skip bonding-curve pools (pump.fun curve "pumpfun"/"pump-fun", Meteora DBC
    // "meteoradbc"): pre-migration tokens. Both such trades in the first live
    // hours were rugs; pump.fun's 1% fee each way is also the most expensive.
    skipBondingCurves: true,
    // Cancel a delayed buy if the pool's liquidity fell more than this share
    // between the signal and the fill (liquidity being pulled = rug in progress).
    maxLiquidityDropAtFillPct: 0.3,
    // Max buys (fills + orders placed) in any rolling 60 minutes. The first
    // live hour after the cost model went live had ~50 buys/hour.
    maxBuysPerHour: 12,
    // Skip a new token whose SYMBOL we bought in the last N minutes (a different
    // mint). Rugged coins are often relaunched under the same name minutes later.
    // 0 = off (default): on the first live hour it removed as many winners as
    // rugs. Try 120 to test it. The per-mint cooldown is filters.reentryCooldownMinutes.
    symbolCooldownMinutes: 0,
  },

  filters: {
    maxAgeMinutes: 60, // only buy pools younger than this ("very new")
    minLiquidityUsd: 20_000, // skip thin pools (high slippage, easy to rug)
    // Skip brand-new pools with MORE than this: in the first live hours, 4 of 6
    // trades in $80k+ pools were rugs (creator-seeded liquidity that got pulled). 0 = off.
    maxLiquidityUsd: 80_000,
    // Minimum candidate score (0-100, see scoring.ts). Below 50, 5 of 6 live
    // trades were rugs. 0 = off.
    minScore: 50,
    minVolumeH1Usd: 5_000, // needs real trading in the last hour
    minTxnsH1: 30, // needs real activity, not one whale
    minSellsH1: 3, // honeypot hint: lots of buys, nobody can sell
    maxFdvToLiquidity: 40, // thin liquidity vs. valuation = easy to rug
    maxPriceChangeM5Pct: 150, // don't chase a vertical candle (in %, not a fraction)
    minPriceChangeM5Pct: -25, // don't catch a falling knife (in %, not a fraction)
    reentryCooldownMinutes: 120, // never re-buy a mint we traded recently
  },

  exits: {
    // Triggers compare the observed price with your FILL price (after slippage).
    hardStopPct: -0.08, // sell if price is 8% below entry
    takeProfitPct: 0.25, // sell if price is 25% above entry
    maxHoldMinutes: 12, // sell anything held this long
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
    decisionsDays: 3, // keep the decision log this long
    candidatesHours: 6, // keep the candidate feed this long
    // Only log a reject again if its reason changed (avoids ~100k identical rows/day).
    logUnchangedRejects: false,
  },
};

export type Config = typeof CONFIG;
