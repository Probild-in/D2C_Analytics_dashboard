// server/test/lib/async-handler.test.ts
import { describe, it, expect, vi } from "vitest";
import { asyncHandler } from "../../src/lib/async-handler.js";

describe("asyncHandler", () => {
  it("calls the wrapped handler normally when it resolves", async () => {
    const handler = vi.fn(async (_req, res) => {
      res.json({ ok: true });
    });
    const wrapped = asyncHandler(handler as any);
    const res = { json: vi.fn() };
    const next = vi.fn();
    await wrapped({} as any, res as any, next);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards a thrown error to next instead of letting it reject unhandled", async () => {
    const boom = new Error("boom");
    const handler = vi.fn(async () => {
      throw boom;
    });
    const wrapped = asyncHandler(handler as any);
    const next = vi.fn();
    await wrapped({} as any, {} as any, next);
    expect(next).toHaveBeenCalledWith(boom);
  });
});
