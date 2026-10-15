import { Router } from "express";
import pool from "../db.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const result = await pool.query("select * from plans order by monthly_fee_inr");
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        orderLimit: r.order_limit,
        monthlyFeeInr: r.monthly_fee_inr,
        includedMetaAccounts: r.included_meta_accounts,
        includedGoogleAccounts: r.included_google_accounts,
        extraMetaAccountPriceInr: r.extra_meta_account_price_inr,
        extraGoogleAccountPriceInr: r.extra_google_account_price_inr,
        extraShopifyStorePriceInr: r.extra_shopify_store_price_inr,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
