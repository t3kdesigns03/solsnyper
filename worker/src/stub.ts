import type { Env } from "./types";

// The single scheduler Durable Object that drives the 45s loop. Trading state
// lives in D1, not here, so switching to a new name is safe: pause the old one
// first (POST /api/pause), deploy, then POST /api/resume.
// "main-v2" (2026-11-27): the "main" instance kept running pre-lanes code
// after two deploys, so the loop moved to a fresh instance.
// "main-v3": the scheduler now runs ticks through the Worker (SELF binding),
// so future deploys take effect without renaming again.
export const SCHEDULER_NAME = "main-v3";

export function schedulerStub(env: Env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName(SCHEDULER_NAME));
}
