import { describe, it, expect, vi, afterEach } from "vitest";

describe("production CORS requirement", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws on import if NODE_ENV is production and CORS_ORIGIN is unset", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ORIGIN;
    // Supply the other production-only env var (src/middleware/auth.ts) so that
    // guard doesn't fire first and mask the CORS_ORIGIN assertion below — this
    // test isolates the CORS_ORIGIN guard specifically.
    process.env.SUPABASE_URL = "https://example.supabase.co";
    vi.resetModules();
    await expect(import("../src/index.js")).rejects.toThrow(/CORS_ORIGIN/);
  });
});
