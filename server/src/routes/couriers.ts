import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const KNOWN_COURIERS = [
  { id: "courier_delhivery", name: "Delhivery", available: false },
  { id: "courier_shadowfax", name: "Shadowfax", available: false },
];

router.get("/", requireAuth, (_req, res) => {
  res.json(KNOWN_COURIERS);
});

export default router;
