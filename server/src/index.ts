import "dotenv/config";
import express from "express";
import cors from "cors";
import { HttpError } from "./lib/http-error.js";
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
import pendingConnectionsRouter from "./routes/pending-connections.js";
import shopifyWebhooksRouter from "./routes/shopify-webhooks.js";
import delhiveryWebhooksRouter from "./routes/delhivery-webhooks.js";
import shiprocketWebhooksRouter from "./routes/shiprocket-webhooks.js";
import { startScheduler } from "./scheduler.js";

const app = express();
const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim());
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));
// Mounted ahead of express.json(): Shopify webhook HMAC verification needs the raw,
// unparsed request body, and this router applies its own express.raw() for just this path.
app.use("/api/webhooks/shopify", shopifyWebhooksRouter);
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
app.use("/api/connections/pending", pendingConnectionsRouter);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
});

export default app;

if (process.env.NODE_ENV !== "test") {
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`server listening on ${port}`));
  startScheduler();
}
