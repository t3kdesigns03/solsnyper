// Market relay for the solsnyper Worker. See worker/src/relay/core.ts.
//
// GeckoTerminal and DexScreener rate-limit Cloudflare Workers' shared IPs, so
// the Worker calls this function (running on Netlify/AWS) once per tick.
// Auth: header `x-relay-token` must equal the RELAY_TOKEN env var.
// The logic lives in the worker package so it is tested there; Netlify's
// bundler pulls it in through this relative import. Changes under worker/src
// trigger a Netlify rebuild via the `ignore` rule in netlify.toml.
import { buildMarketResponse, parseRelayRequest } from "../../../worker/src/relay/core";

declare const process: { env: Record<string, string | undefined> };

/** Length-independent, constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req: Request): Promise<Response> => {
  const expected = process.env.RELAY_TOKEN;
  if (!expected) return json({ error: "relay not configured" }, 503);
  if (!safeEqual(req.headers.get("x-relay-token") ?? "", expected)) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = parseRelayRequest(body);
  if (!parsed) return json({ error: "body must be {mints: string[]}" }, 400);

  return json(await buildMarketResponse(parsed));
};

export const config = { path: "/api/market" };
