import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import app from "../src/index.js";
import pool from "../src/db.js";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const querySpy = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("connection refused"));
    try {
      const res = await request(app).get("/health");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: "error" });
    } finally {
      querySpy.mockRestore();
    }
  });
});
