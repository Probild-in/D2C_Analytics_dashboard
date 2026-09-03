import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";

const router = Router({ mergeParams: true });

const CAMPAIGN_STATUS_DISPLAY: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  "in review": "In Review",
  completed: "Completed",
};

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const platform = req.query.platform === "google" ? "google" : "meta";
    const metricsTable = platform === "google" ? "google_campaign_metrics" : "meta_campaign_metrics";
    const resultsColumn = platform === "google" ? "conversions" : "results";

    const result = await pool.query(
      `select
         c.id, c.name, c.status,
         coalesce(sum(m.spend), 0)::int as spend,
         coalesce(sum(m.impressions), 0)::int as impressions,
         coalesce(sum(m.clicks), 0)::int as clicks,
         coalesce(sum(m.${resultsColumn}), 0)::int as results
       from campaigns c
       join platform_connections pc on pc.id = c.connection_id
       left join ${metricsTable} m on m.campaign_id = c.external_campaign_id and m.connection_id = c.connection_id
       where c.client_id = $1 and pc.platform = $2
       group by c.id, c.name, c.status
       order by spend desc`,
      [clientId, platform],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        clientId,
        platform,
        name: r.name,
        status: CAMPAIGN_STATUS_DISPLAY[r.status] ?? "Paused",
        spend: r.spend,
        results: r.results,
        resultType: platform === "google" ? "Conversions" : "Purchases",
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
        cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
        cpm: r.impressions > 0 ? (r.spend / r.impressions) * 1000 : 0,
        roas: 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/:campaignId/creatives", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const campaignId = req.params.campaignId;

    const result = await pool.query(
      `select cc.* from campaign_creatives cc
       join campaigns c on c.id = cc.campaign_id
       where cc.campaign_id = $1 and c.client_id = $2
       order by cc.spend desc`,
      [campaignId, clientId],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        campaignId,
        name: r.name,
        format: r.format,
        headline: r.headline ?? "",
        primaryText: r.primary_text ?? "",
        cta: r.cta ?? "",
        thumbnailUrl: r.thumbnail_url,
        status: CAMPAIGN_STATUS_DISPLAY[r.status] ?? "Paused",
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
        cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
        results: r.results,
        roas: 0,
        hookRate: r.hook_rate !== null ? Number(r.hook_rate) : null,
        holdRate: r.hold_rate !== null ? Number(r.hold_rate) : null,
        // Local-getter extraction, not .toISOString() — `launched_date` is a Postgres
        // `date` column with no time/timezone component, and pg's driver parses it into a
        // JS Date via a local-midnight constructor. .toISOString() would convert that back
        // to UTC and roll the date back one day on any positive-UTC-offset host (the exact
        // bug class the Shopify plan's Task 8 found and fixed three times over).
        launchedDate: r.launched_date
          ? `${r.launched_date.getFullYear()}-${String(r.launched_date.getMonth() + 1).padStart(2, "0")}-${String(r.launched_date.getDate()).padStart(2, "0")}`
          : null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/:campaignId/notes", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const campaignId = req.params.campaignId;

    const result = await pool.query(
      `select cn.id, cn.body, cn.created_at, tm.name as author_name
       from campaign_notes cn
       join campaigns c on c.id = cn.campaign_id
       join team_members tm on tm.id = cn.author_id
       where cn.campaign_id = $1 and c.client_id = $2
       order by cn.created_at asc`,
      [campaignId, clientId],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        campaignId,
        author: r.author_name,
        authorRole: "marketing",
        message: r.body,
        timestamp: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:campaignId/notes", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const campaignId = req.params.campaignId;

    const body = (req.body as { body?: string }).body;
    if (!body || !body.trim()) {
      throw new HttpError(400, "invalid_body", "body is required");
    }

    const inserted = await pool.query(
      `insert into campaign_notes (campaign_id, author_id, body)
       select $1, $2, $3 where exists (select 1 from campaigns where id = $1 and client_id = $4)
       returning id, body, created_at`,
      [campaignId, req.auth!.userId, body.trim(), clientId],
    );
    if (inserted.rowCount === 0) {
      throw new HttpError(404, "not_found", "Campaign not found");
    }

    const authorResult = await pool.query("select name from team_members where id = $1", [req.auth!.userId]);
    res.status(201).json({
      id: inserted.rows[0].id,
      campaignId,
      author: authorResult.rows[0].name,
      authorRole: "marketing",
      message: inserted.rows[0].body,
      timestamp: inserted.rows[0].created_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
