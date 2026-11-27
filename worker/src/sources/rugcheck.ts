import { getJson, num } from "./http";

// GUESS / UNDOCUMENTED-ISH: RugCheck's public token report summary
//   GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary
// (~150 bytes, no key). Observed shape: { score, score_normalised, lpLockedPct,
// risks: [{ name, value, description, score, level }] }. It may rate limit or
// change; every call is fail-soft and results are cached per mint in D1
// (token_risk), so each token is looked up once.

const BASE = "https://api.rugcheck.xyz/v1/tokens";

export interface RiskSummary {
  score: number | null; // raw RugCheck score (higher = riskier)
  scoreNormalised: number | null;
  lpLockedPct: number | null; // share of pool liquidity locked/burned, 0-100
  risks: { name: string; level: string }[]; // e.g. "Mint Authority still enabled" / "danger"
}

interface RawSummary {
  score?: number;
  score_normalised?: number;
  lpLockedPct?: number;
  risks?: { name?: string; level?: string }[];
}

export function toRiskSummary(r: RawSummary): RiskSummary {
  return {
    score: typeof r.score === "number" ? r.score : null,
    scoreNormalised: typeof r.score_normalised === "number" ? r.score_normalised : null,
    lpLockedPct: r.lpLockedPct === undefined || r.lpLockedPct === null ? null : num(r.lpLockedPct),
    risks: (Array.isArray(r.risks) ? r.risks : [])
      .filter((x) => typeof x?.name === "string")
      .map((x) => ({ name: String(x.name).slice(0, 80), level: String(x.level ?? "").slice(0, 16) })),
  };
}

/** Look up several mints in parallel. Failed lookups are simply missing from the result. */
export async function fetchRiskSummaries(mints: string[], timeoutMs = 4000): Promise<{ risk: Record<string, RiskSummary>; errors: string[] }> {
  const risk: Record<string, RiskSummary> = {};
  const errors: string[] = [];
  const res = await Promise.allSettled(mints.map((m) => getJson<RawSummary>(`${BASE}/${m}/report/summary`, timeoutMs)));
  res.forEach((r, i) => {
    if (r.status === "fulfilled") risk[mints[i]] = toRiskSummary(r.value);
    else errors.push(String(r.reason));
  });
  return { risk, errors: errors.length ? [`rugcheck: ${errors.length}/${mints.length} failed (${errors[0]})`] : [] };
}
