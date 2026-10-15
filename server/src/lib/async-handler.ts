import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an async Express route handler so a rejected promise is forwarded to `next`
 * instead of becoming an unhandled rejection. Express 4 (this project's version) does
 * NOT do this automatically for async handlers — only Express 5 does. Existing routes
 * in this codebase already handle this themselves (each wraps its own body in
 * try/catch and calls next(err)); this wrapper exists so future routes can opt in
 * without having to remember that pattern by hand.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
