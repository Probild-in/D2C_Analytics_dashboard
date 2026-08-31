import express from "express";
import { HttpError } from "./lib/http-error.js";
import clientsRouter from "./routes/clients.js";
import connectionsRouter from "./routes/connections.js";
import billingRouter from "./routes/billing.js";

const app = express();
app.use(express.json());
app.use("/api/clients", clientsRouter);
app.use("/api/clients/:id/connections", connectionsRouter);
app.use("/api/clients/:id/subscription", billingRouter);

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
