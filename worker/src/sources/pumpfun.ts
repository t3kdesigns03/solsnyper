import type { DiscoveredMint } from "../types";
import { getJson } from "./http";

// GUESS / UNOFFICIAL: pump.fun has no documented public API. This is the
// endpoint their own web app calls for "newest coins". It may change, rate
// limit, or block requests from Cloudflare IPs at any time. It is fail-soft:
// if it errors, the tick carries on with the other sources and the error is
// recorded in the `runs` table. Disable with ENABLE_PUMPFUN="false".
//
// Pump.fun coins only give us a mint here; pricing and liquidity still come
// from GeckoTerminal / DexScreener (both index pump.fun bonding-curve pools). Most brand-new pump.fun coins will fail the $20k liquidity
// filter, which is expected.

const URL_NEWEST =
  "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false";

interface PumpCoin {
  mint: string;
  symbol?: string;
  created_timestamp?: number;
}

export async function discoverPumpFun(): Promise<DiscoveredMint[]> {
  const rows = await getJson<PumpCoin[] | { coins?: PumpCoin[] }>(URL_NEWEST);
  const list = Array.isArray(rows) ? rows : rows.coins ?? [];
  return list
    .filter((c) => typeof c?.mint === "string" && c.mint.length > 30)
    .map((c) => ({ mint: c.mint, source: "pumpfun", hintSymbol: c.symbol }));
}
