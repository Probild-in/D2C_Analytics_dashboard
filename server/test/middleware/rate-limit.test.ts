import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { createRateLimiter } from "../../src/middleware/rate-limit.js";
import { HttpError } from "../../src/lib/http-error.js";

function fakeReq(userId: string, clientId: string): Request {
  return { auth: { userId, email: "x@y.z" }, params: { id: clientId } } as unknown as Request;
}

const res = {} as Response;

describe("createRateLimiter", () => {
  it("allows up to max requests then returns a 429 HttpError", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => 0 });
    const next = vi.fn();
    limiter(fakeReq("u1", "c1"), res, next);
    limiter(fakeReq("u1", "c1"), res, next);
    limiter(fakeReq("u1", "c1"), res, next);
    expect(next).toHaveBeenNthCalledWith(1);
    expect(next).toHaveBeenNthCalledWith(2);
    const third = next.mock.calls[2][0];
    expect(third).toBeInstanceOf(HttpError);
    expect(third.status).toBe(429);
    expect(third.code).toBe("rate_limited");
  });

  it("tracks users and clients independently", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    const next = vi.fn();
    limiter(fakeReq("u1", "c1"), res, next);
    limiter(fakeReq("u2", "c1"), res, next);
    limiter(fakeReq("u1", "c2"), res, next);
    expect(next.mock.calls.every((call) => call.length === 0)).toBe(true);
  });

  it("forgets attempts once the window has passed", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    const next = vi.fn();
    limiter(fakeReq("u1", "c1"), res, next);
    t = 1001;
    limiter(fakeReq("u1", "c1"), res, next);
    expect(next.mock.calls.every((call) => call.length === 0)).toBe(true);
  });
});
