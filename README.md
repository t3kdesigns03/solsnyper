# SolSnyper: simulated Solana meme-coin sniper

**Paper trading only.** No wallets, no private keys, no transactions. It reads real
market data, decides deterministically, and books fake $20 fills against a fake
$1,000 wallet in D1.

```
worker/   Cloudflare Worker + D1 + Durable Object (the bot and the JSON API)
web/      Next.js 14 App Router + Tailwind dashboard (static export -> Cloudflare Pages)
```

## How a tick works (every 45s)

1. **Discover** new Solana mints: DexScreener `token-profiles/latest` + `token-boosts/latest`,
   plus pump.fun's newest coins (unofficial, see below).
2. **Price** every discovered mint and every open position in one go via DexScreener
   `tokens/v1/solana/{up to 30 mints}`; the deepest Solana pair wins.
3. **Exits first**: each open position is re-priced and checked against the exit rules.
4. **Entry filters** on each candidate; survivors are ranked by score; buy up to 3 per tick
   (max 10 open) while cash lasts.
5. **Persist** in one D1 batch: positions, trades, candidates, decisions, wallet, equity snapshot, run log.

Steps 3 and 4 are one pure function, `planTick()` in `worker/src/strategy/decide.ts`
(state + market data + time → plan). No randomness, no LLM, fully unit-tested.

### Why a Durable Object (the 45s problem)

Cron triggers can't run more often than once a minute. So a single Durable Object
(`Scheduler`) sets an **alarm** 45s ahead, runs a tick when it fires, and re-arms.
Alarms never overlap (no double-buys), and Cloudflare retries them on failure. The
`* * * * *` cron is only a **watchdog** that re-arms the alarm if it's ever missing
(first deploy, after a pause). The DO is declared as SQLite-backed
(`new_sqlite_classes`), which works on the Workers free plan.

## Strategy (all in `worker/src/config.ts`)

| | Rule |
|---|---|
| Size | $20 per buy (network fee on top), max 10 open, max 3 new buys per tick |
| Costs | DEX fee by pool (pump.fun 1%, Raydium 0.25%, others ~0.3%) + gas (0.000505 SOL/tx) + slippage (price impact + 0.5%); orders fill one tick (~45s) after the decision |
| Entry | pair ≤ 60 min old, liquidity ≥ $20k, 1h volume ≥ $5k, ≥ 30 txns/1h, ≥ 3 sells/1h (honeypot hint), FDV/liquidity ≤ 40x, 5m change between −25% and +150%, not held, not traded in the last 2h |
| Exits (first match wins) | stale price (4 missed ticks) → **−8% hard stop** → liquidity < 40% of entry (rug) → **+25% take profit** → **give-back**: after a +10% peak, exit once 60% of the gain is gone → **12 min max hold** |
| Ranking | 0-100 score from liquidity, turnover, buy pressure, freshness |

Orders fill one tick after the decision, at that tick's price plus slippage, so a stop can
"gap" past −8%. That is deliberate: it's closer to reality.

## Tuning

Every threshold lives in `worker/src/config.ts`, each with a one-line comment. Change a
number, run `npm test` and `npm run deploy` in `worker/`, then (optionally)
`POST /api/reset` (or the dashboard's **Reset paper wallet** button) to start a fresh run. Fractions are fractions: `0.01` = 1%.

**Know your hurdle first.** A $20 buy + sell at an *unchanged* price costs (at the $100 default, add ~0.5–1 point in $25–40k pools for the extra price impact):

| Pool | DEX fees | Gas (SOL $72 / $200) | Slippage | Total, SOL $72 | Total, SOL $200 |
|---|---|---|---|---|---|
| pump.fun curve, $25k liquidity | $0.40 | $0.07 / $0.20 | $0.26 | **$0.73 (3.6%)** | $0.86 (4.3%) |
| PumpSwap, $25k | $0.12 | $0.07 / $0.20 | $0.26 | **$0.45 (2.3%)** | $0.58 (2.9%) |
| Raydium, $25k | $0.10 | $0.07 / $0.20 | $0.26 | **$0.43 (2.2%)** | $0.56 (2.8%) |
| Raydium, $250k | $0.10 | $0.07 / $0.20 | $0.21 | **$0.38 (1.9%)** | $0.51 (2.5%) |
| *old flat model* | | | | *$0.16 (0.8%)* | |

So a trade has to move roughly **+2–4% just to break even**. The dashboard's **Cost model**
panel shows these numbers live at the current SOL price.

| Group | Knob | Default | What moving it does |
|---|---|---|---|
| wallet | `buySizeUsd` | 100 | Base (and minimum) trade size. Bigger = gas matters less, slippage matters more |
| | `maxBuySizeUsd` / `maxPoolSharePct` | 250 / 0.005 | Scale up in deep pools: never above 0.5% of liquidity, only while the round trip stays under the cost cap |
| | `maxOpenPositions` / `maxBuysPerTick` | 10 / 3 | Exposure caps |
| | `startingEquityUsd` | 10,000 | Default bankroll for `/api/reset` (the dashboard's reset button can set its own) |
| costs | `dexFeePct` | pumpfun 1%, pumpswap 0.3%, raydium 0.25%, meteora/orca 0.3%, default 0.3% | Per-DEX swap fee, matched on the pool's dexId (exact, then prefix) |
| | `networkFeeSol` + `priorityFeeSol` | 0.000005 + 0.0005 SOL | Gas per transaction (2 per round trip), at the live SOL price |
| | `extraSlippagePct` | 0.005 | Buffer on top of price impact (MEV, in-block moves) |
| | `fillDelayTicks` | 1 | 0 = fill instantly at the trigger price (optimistic), 1 = next tick, 2+ = slower |
| | `fallbackSolPriceUsd` | 150 | Only used if no SOL price was ever fetched |
| | `usePatientPriorityFee` / `patientPriorityFeeSol` | false / 0.0001 | Cheaper gas; in real life risks slower fills (not modelled, so a best case) |
| costControl | `maxRoundTripCostPct` | 0.03 | Skip pools whose $-size round trip costs more; re-checked at fill, so a pool drained between signal and fill is cancelled instead of bought |
| | `minEdgeMultiple` | 2 | Take-profit must be ≥ this × the pool's round-trip cost |
| | `skipBondingCurves` | true | Skip bonding-curve pools (pump.fun curve, Meteora DBC): pre-migration tokens |
| | `maxLiquidityDropAtFillPct` | 0.3 | Cancel a delayed buy if liquidity fell more than 30% between signal and fill |
| | `maxBuysPerHour` | 12 | Rolling-hour cap on buys (fills + pending orders) |
| | `symbolCooldownMinutes` | 0 (off) | Skip a symbol bought recently under another mint (relaunch rugs) |
| filters | `maxAgeMinutes` | 60 | How new a pool must be |
| | `minLiquidityUsd` | 20,000 | Higher = less slippage and rug risk, fewer trades |
| | `maxLiquidityUsd` | 80,000 | Skip brand-new pools seeded with more (seeded-and-pulled rugs). 0 = off |
| | `minScore` | 50 | Minimum candidate score (0–100). 0 = off |
| | `minVolumeH1Usd` / `minTxnsH1` | 5,000 / 30 | Minimum real activity |
| | `minSellsH1` | 3 | Honeypot hint |
| | `maxFdvToLiquidity` | 40 | Thin liquidity vs. valuation = easy to rug |
| | `minPriceChangeM5Pct` / `maxPriceChangeM5Pct` | −25 / 150 (percent) | Don't catch knives / chase candles |
| | `reentryCooldownMinutes` | 120 | No re-buying a recent trade |
| exits | `hardStopPct` | −0.08 | Stop loss, measured from your fill price |
| | `takeProfitPct` | 0.25 | Take profit, measured from your fill price |
| | `givebackArmAtGainPct` / `givebackFraction` | 0.10 / 0.6 | After +10%, exit once 60% of the peak gain is gone |
| | `maxHoldMinutes` | 12 | Time stop |
| | `liquidityCollapseFraction` | 0.4 | Exit if liquidity falls below 40% of entry |
| | `maxMissedUpdates` | 4 | Close after this many ticks without a price |
| — | `tickIntervalMs` | 45,000 | Loop speed (also the length of one fill delay) |

Tips: with ~3% round-trip costs, a +25% take-profit nets about +22% and a −8% stop loses
about −11%. Raising `minLiquidityUsd` or avoiding pump.fun pools (1% each way) cuts costs
most. Each closed trade on the dashboard shows its DEX/gas/slippage split; hover it to see
signal price vs. fill price.

### Extending it

- **New entry check** (e.g. a real rug check: mint authority, top holders, LP burn):
  add an object to `ENTRY_RULES` in `worker/src/strategy/filters.ts`. Return `null` to
  pass or a reason string to reject. If it needs extra data, add it to `FilterContext`
  and fill it in `engine.ts`.
- **New exit**: add to `EXIT_RULES` in `worker/src/strategy/exits.ts` (order = priority).
- **Better scoring**: replace `scoreCandidate()` in `scoring.ts`.
- **New data source**: return `DiscoveredMint[]` from a function in `worker/src/sources/`
  and add it to `liveSources.discover` in `engine.ts`.

### Guesses / caveats

- **pump.fun**: there's no documented public API. `sources/pumpfun.ts` calls the endpoint
  their web app uses (`frontend-api-v3.pump.fun/coins?sort=created_timestamp`). It may block
  Cloudflare IPs or change at any time. It fails soft (the error shows on the dashboard
  under "Source warnings") and can be turned off with `ENABLE_PUMPFUN = "false"`.
- **DexScreener** has no "new pairs" endpoint; the latest-profiles/boosts feeds are the best
  public proxy. Many tokens there are older than 60 min and get rejected; that's expected.
- Rejections are logged to `decisions` only when a mint's reject reason **changes**, otherwise
  the same ~60 rejects would be re-logged every 45s (~100k rows/day). Set
  `retention.logUnchangedRejects: true` to log every evaluation.
- Decisions and runs are kept 3 days, candidates 6 hours.

## Run locally

```bash
# Worker
cd worker
npm install
cp .dev.vars.example .dev.vars          # ADMIN_TOKEN + MOCK_MARKET=true (offline fake market)
npm run db:migrate:local
npm run dev                             # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # arms the 45s loop
npm test                                # 22 tests (strategy + end-to-end against SQLite)

# Dashboard (another terminal)
cd web
npm install
echo NEXT_PUBLIC_API_URL=http://localhost:8787 > .env.local
npm run dev                             # http://localhost:3000
```

Remove `MOCK_MARKET` from `.dev.vars` to use live DexScreener/pump.fun data locally.
With no `NEXT_PUBLIC_API_URL`, the dashboard shows built-in demo data.

## Deploy to Cloudflare

```bash
cd worker
npx wrangler login
npx wrangler d1 create solsnyper          # paste database_id into wrangler.toml
npm run db:migrate:remote
npx wrangler secret put ADMIN_TOKEN       # any long random string
npm run deploy                            # prints https://solsnyper-worker.<you>.workers.dev
```

The cron watchdog starts the 45s loop within a minute of deploying.

**Pages** (dashboard): Cloudflare dashboard → Workers & Pages → Create → Pages → connect this repo.
- Root directory: `web`
- Build command: `npm run build`
- Output directory: `out`
- Env var: `NEXT_PUBLIC_API_URL=https://solsnyper-worker.<you>.workers.dev`

Or from the CLI: `cd web && NEXT_PUBLIC_API_URL=... npm run build && npx wrangler pages deploy out --project-name solsnyper`.

Then set `ALLOWED_ORIGIN` in `wrangler.toml` to your Pages URL and redeploy the Worker.

## API

| | |
|---|---|
| `GET /api/summary` | wallet, PnL, cost totals + round-trip examples, pending orders, last run, scheduler status, config |
| `GET /api/orders` | orders decided but not yet filled |
| `GET /api/candidates` | latest candidates with pass/fail reason |
| `GET /api/positions` · `/api/closed` · `/api/trades` | open positions, closed positions, raw buy/sell legs |
| `GET /api/decisions?action=buy\|sell\|skip\|reject` | decision log |
| `GET /api/equity?hours=24` | equity curve (≤ 300 points) |
| `POST /api/run` · `/api/pause` · `/api/resume` · `/api/reset` | admin, needs `Authorization: Bearer $ADMIN_TOKEN` |
