import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { HttpError } from "../lib/http-error.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; email: string };
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    next(new HttpError(401, "unauthorized", "Missing bearer token"));
    return;
  }
  const token = header.slice("Bearer ".length);
  const secret = process.env.SUPABASE_JWT_SECRET ?? "test-secret";
  try {
    const decoded = jwt.verify(token, secret) as { sub: string; email: string };
    req.auth = { userId: decoded.sub, email: decoded.email };
    next();
  } catch {
    next(new HttpError(401, "unauthorized", "Invalid or expired token"));
  }
}
