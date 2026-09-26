import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/http-error.js";

// In-memory sliding-window limiter. The API runs as a single process, so a per-process map
// is enough; it exists to blunt credential-guessing through the connect endpoint, not to be
// a general-purpose quota system. Must be mounted after requireAuth so req.auth is set.
export function createRateLimiter({
  max,
  windowMs,
  now = Date.now,
}: {
  max: number;
  windowMs: number;
  now?: () => number;
}) {
  const hits = new Map<string, number[]>();

  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${req.auth?.userId ?? "anon"}:${req.params.id ?? ""}`;
    const t = now();
    const recent = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      next(new HttpError(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again."));
      return;
    }
    recent.push(t);
    hits.set(key, recent);
    next();
  };
}
