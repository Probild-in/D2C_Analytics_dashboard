import { Router } from "express";
import pool from "../db.js";
import { HttpError } from "../lib/http-error.js";
import { createRateLimiter } from "../middleware/rate-limit.js";

const router = Router();

router.post("/", createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000, scope: "ip" }), async (req, res, next) => {
  try {
    const { name, email, company, estimatedOrdersPerMonth, message } = req.body as {
      name?: string;
      email?: string;
      company?: string;
      estimatedOrdersPerMonth?: number;
      message?: string;
    };
    if (!name?.trim() || !email?.trim() || !company?.trim()) {
      throw new HttpError(400, "missing_fields", "name, email, and company are all required");
    }
    await pool.query(
      `insert into enterprise_leads (name, email, company, estimated_orders_per_month, message) values ($1, $2, $3, $4, $5)`,
      [name.trim(), email.trim(), company.trim(), estimatedOrdersPerMonth ?? null, message?.trim() || null],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
