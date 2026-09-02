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

const app = express();
const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim());
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));
app.use(express.json());
app.use("/api/clients", clientsRouter);
app.use("/api/clients/:id/connections", connectionsRouter);
// mount this AFTER the existing connectionsRouter mount on the same path — Express tries
// routers in mount order, and connections.ts's own routes (GET /, POST /:platform/authorize)
// don't overlap with this router's POST /:platform/sync path, so order between the two
// doesn't actually matter here, but keep it directly below the connections mount for readability.
app.use("/api/clients/:id/connections", syncRouter);
app.use("/api/clients/:id/subscription", billingRouter);
app.use("/api/couriers", couriersRouter);
app.use("/api/integrations", integrationsRouter);

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
}
