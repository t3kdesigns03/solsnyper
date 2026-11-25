// Shared (server + client) config. Inlined at build time by Next.js.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
export const DEMO = API_URL === "";
