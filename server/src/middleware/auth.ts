import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "../lib/http-error.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; email: string };
    }
  }
}

// Tests sign their own tokens with a static HS256 secret (see test/helpers/test-jwt.ts).
// Real Supabase Auth tokens are signed with the project's asymmetric JWT signing key
// (ES256 by default on newer projects) and must be verified against Supabase's JWKS
// endpoint instead — there is no shared secret to check them against.
const isTestEnv = process.env.NODE_ENV === "test";
const testSecret = process.env.SUPABASE_JWT_SECRET ?? "test-secret";

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl && !isTestEnv) {
  throw new Error("SUPABASE_URL environment variable must be set (except in test environments)");
}

const jwks = !isTestEnv && supabaseUrl
  ? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
  : null;

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    next(new HttpError(401, "unauthorized", "Missing bearer token"));
    return;
  }
  const token = header.slice("Bearer ".length);

  if (isTestEnv) {
    try {
      const decoded = jwt.verify(token, testSecret) as { sub: string; email: string };
      req.auth = { userId: decoded.sub, email: decoded.email };
      next();
    } catch {
      next(new HttpError(401, "unauthorized", "Invalid or expired token"));
    }
    return;
  }

  try {
    const { payload } = await jwtVerify(token, jwks!, { issuer: `${supabaseUrl}/auth/v1` });
    req.auth = { userId: payload.sub as string, email: payload.email as string };
    next();
  } catch {
    next(new HttpError(401, "unauthorized", "Invalid or expired token"));
  }
}
