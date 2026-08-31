import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { requireAuth } from "../../src/middleware/auth.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { HttpError } from "../../src/lib/http-error.js";

function buildApp() {
  const app = express();
  app.get("/protected", requireAuth, (req, res) => {
    res.json({ userId: req.auth!.userId });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(err.toBody());
      return;
    }
    res.status(500).json({ error: { code: "internal_error", message: "unexpected" } });
  });
  return app;
}

describe("requireAuth", () => {
  it("rejects requests with no Authorization header", async () => {
    const res = await request(buildApp()).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects an invalid token", async () => {
    const res = await request(buildApp()).get("/protected").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("accepts a validly signed token and attaches req.auth", async () => {
    const token = signTestJwt({ sub: "user-123", email: "riya@agency.com" });
    const res = await request(buildApp()).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe("user-123");
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = jwt.sign({ sub: "user-123", email: "riya@agency.com" }, "wrong-secret", { algorithm: "HS256" });
    const res = await request(buildApp()).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects an expired token", async () => {
    const secret = process.env.SUPABASE_JWT_SECRET ?? "test-secret";
    const token = jwt.sign({ sub: "user-123", email: "riya@agency.com" }, secret, { algorithm: "HS256", expiresIn: "-1h" });
    const res = await request(buildApp()).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });
});
