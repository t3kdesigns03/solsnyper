import { describe, expect, it } from "vitest";
import { corsOrigin, handleApi } from "../src/api";
import type { Env } from "../src/types";

const LIST = "https://solsniperr.netlify.app, https://snipetester.clidk.com/";

describe("CORS origin allowlist", () => {
  it("echoes a listed origin", () => {
    expect(corsOrigin(LIST, "https://snipetester.clidk.com")).toBe("https://snipetester.clidk.com");
    expect(corsOrigin(LIST, "https://solsniperr.netlify.app")).toBe("https://solsniperr.netlify.app");
  });

  it("does not echo an unlisted origin", () => {
    expect(corsOrigin(LIST, "https://evil.example")).toBe("https://solsniperr.netlify.app");
    expect(corsOrigin(LIST, null)).toBe("https://solsniperr.netlify.app");
  });

  it("allows everything with * or when unset", () => {
    expect(corsOrigin("*", "https://x.example")).toBe("*");
    expect(corsOrigin(undefined, "https://x.example")).toBe("*");
  });

  it("sends the header and Vary: Origin on API responses and preflights", async () => {
    const env = { ALLOWED_ORIGIN: LIST } as unknown as Env;
    const req = (method: string) => new Request("https://w/api", { method, headers: { origin: "https://snipetester.clidk.com" } });
    for (const r of [await handleApi(req("GET"), env), await handleApi(req("OPTIONS"), env)]) {
      expect(r.headers.get("access-control-allow-origin")).toBe("https://snipetester.clidk.com");
      expect(r.headers.get("vary")).toBe("Origin");
    }
  });
});
