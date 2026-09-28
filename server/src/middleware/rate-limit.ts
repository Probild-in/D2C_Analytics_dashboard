import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/http-error.js";

// In-memory sliding-window limiter. The API runs as a single process, so a per-process map
// is enough; it exists to blunt credential-guessing through the connect endpoint, not to be
// a general-purpose quota system. Must be mounted after requireAuth so req.auth is set.
//
// scope "user-and-client" (default) counts per user per client; scope "user" counts per user
// across every client. Keys include a user-supplied client id, so once the map holds more
// than maxKeys entries, keys whose attempts have all expired are swept before counting.
export function createRateLimiter({
  max,
  windowMs,
  now = Date.now,
  scope = "user-and-client",
  maxKeys = 5000,
}: {
  max: number;
  windowMs: number;
  now?: () => number;
  scope?: "user" | "user-and-client";
  maxKeys?: number;
}) {
  const hits = new Map<string, number[]>();

  const middleware = (req: Request, _res: Response, next: NextFunction) => {
    const userId = req.auth?.userId ?? "anon";
    const key = scope === "user" ? userId : `${userId}:${req.params.id ?? ""}`;
    const t = now();

    if (hits.size > maxKeys) {
      for (const [k, stamps] of hits) {
        if (stamps.every((ts) => t - ts >= windowMs)) hits.delete(k);
      }
    }

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

  return Object.assign(middleware, { size: () => hits.size });
}
