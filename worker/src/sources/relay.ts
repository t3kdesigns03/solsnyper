import type { RelayResponse } from "../relay/core";
import type { DiscoveredMint, MarketSnapshot } from "../types";

// Client for the Netlify market relay (web/netlify/functions/market.mts).
// One POST per tick; any failure throws so the engine can fall back to direct calls.

export async function callRelay(
  url: string,
  token: string,
  mints: string[],
  opts: { dexscreener?: boolean; timeoutMs?: number } = {},
): Promise<RelayResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-relay-token": token },
    body: JSON.stringify({ mints: [...new Set(mints)], dexscreener: opts.dexscreener !== false }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from relay`);
  const body = (await res.json()) as Partial<RelayResponse>;
  if (!Array.isArray(body?.snapshots) || !Array.isArray(body?.discovered)) throw new Error("relay returned an unexpected body");
  return {
    discovered: body.discovered.filter((d): d is DiscoveredMint => typeof d?.mint === "string" && typeof d?.source === "string"),
    snapshots: body.snapshots.filter((s): s is MarketSnapshot => typeof s?.mint === "string" && typeof s?.priceUsd === "number"),
    solPriceUsd: typeof body.solPriceUsd === "number" ? body.solPriceUsd : null,
    errors: Array.isArray(body.errors) ? body.errors.map(String) : [],
  };
}
