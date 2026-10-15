import pino from "pino";

// Pretty-print in dev/test for readability; plain JSON lines in production, which is
// what a process manager's journal (this project's systemd + journalctl) and most log
// aggregators expect.
const isProd = process.env.NODE_ENV === "production";

export const logger = pino(
  isProd
    ? { level: "info" }
    : {
        level: "debug",
        transport: { target: "pino-pretty", options: { colorize: true } },
      },
);
