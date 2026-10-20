import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { HttpError } from "./lib/http-error.js";
import { logger } from "./lib/logger.js";
import pool from "./db.js";
import clientsRouter from "./routes/clients.js";
import connectionsRouter from "./routes/connections.js";
import syncRouter from "./routes/sync.js";
import billingRouter from "./routes/billing.js";
import couriersRouter from "./routes/couriers.js";
import integrationsRouter from "./routes/integrations.js";
import shopifyDataRouter from "./routes/shopify-data.js";
import courierDataRouter from "./routes/courier-data.js";
import campaignsRouter from "./routes/campaigns.js";
import tasksRouter from "./routes/tasks.js";
import teamMembersRouter from "./routes/team-members.js";
import notificationsRouter from "./routes/notifications.js";
import pendingConnectionsRouter from "./routes/pending-connections.js";
import shopifyWebhooksRouter from "./routes/shopify-webhooks.js";
import razorpayWebhooksRouter from "./routes/razorpay-webhooks.js";
import delhiveryWebhooksRouter from "./routes/delhivery-webhooks.js";
import shiprocketWebhooksRouter from "./routes/shiprocket-webhooks.js";
import publicPlansRouter from "./routes/public-plans.js";
import signupRouter from "./routes/signup.js";
import enterpriseLeadsRouter from "./routes/enterprise-leads.js";
import shopifyAppInstallRouter from "./routes/shopify-app-install.js";
import { startScheduler } from "./scheduler.js";

process.on("unhandledRejection", (reason) => {
  logger.error(reason, "Unhandled promise rejection:");
  if (process.env.NODE_ENV === "production") {
    setTimeout(() => process.exit(1), 1000).unref();
  }
});

process.on("uncaughtException", (err) => {
  logger.error(err, "Uncaught exception:");
  if (process.env.NODE_ENV === "production") {
    setTimeout(() => process.exit(1), 1000).unref();
  }
});

if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGIN?.trim()) {
  throw new Error("CORS_ORIGIN must be set when NODE_ENV=production — refusing to start with CORS open to any origin.");
}

const app = express();
// Production runs behind nginx. Without this, every request's req.ip resolves to
// nginx's own loopback address, which collapses the IP-scoped rate limiters on
// /api/signup, /api/signup/complete, and /api/enterprise-leads into one shared bucket
// for every visitor combined, instead of one bucket per real visitor.
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim());
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));
// Mounted ahead of express.json(): Shopify webhook HMAC verification needs the raw,
// unparsed request body, and this router applies its own express.raw() for just this path.
app.use("/api/webhooks/shopify", shopifyWebhooksRouter);
app.use("/api/webhooks/razorpay", razorpayWebhooksRouter);
app.use(express.json());
app.use("/api/clients", clientsRouter);
app.use("/api/clients/:id/connections", connectionsRouter);
// mount this AFTER the existing connectionsRouter mount on the same path — Express tries
// routers in mount order, and connections.ts's own routes (GET /, POST /:platform/authorize)
// don't overlap with this router's POST /:platform/sync path, so order between the two
// doesn't actually matter here, but keep it directly below the connections mount for readability.
app.use("/api/clients/:id/connections", syncRouter);
app.use("/api/clients/:id/subscription", billingRouter);
app.use("/api/clients/:id", shopifyDataRouter);
app.use("/api/clients/:id/campaigns", campaignsRouter);
app.use("/api/clients/:id/tasks", tasksRouter);
app.use("/api/clients/:id/couriers", courierDataRouter);
app.use("/api/couriers", couriersRouter);
// Unlike Shopify's, neither courier's webhook system has a documented HMAC/signature
// scheme — the connectionId in the URL path (an unguessable UUID) is the practical
// safeguard, so these can sit after the normal express.json() parser.
app.use("/api/webhooks/delhivery", delhiveryWebhooksRouter);
app.use("/api/webhooks/shiprocket", shiprocketWebhooksRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/team-members", teamMembersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/connections/pending", pendingConnectionsRouter);
app.use("/api/plans", publicPlansRouter);
app.use("/api/signup", signupRouter);
app.use("/api/enterprise-leads", enterpriseLeadsRouter);
app.use("/api/shopify-app", shopifyAppInstallRouter);

app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.status(200).json({ status: "ok" });
  } catch (err) {
    logger.error(err, "Health check failed");
    res.status(503).json({ status: "error" });
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  logger.error(err, "Unhandled route error");
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
});

export default app;

if (process.env.NODE_ENV !== "test") {
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => logger.info(`server listening on ${port}`));
  startScheduler();
}
