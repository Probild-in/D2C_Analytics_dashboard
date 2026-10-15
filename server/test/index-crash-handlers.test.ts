// server/test/index-crash-handlers.test.ts
//
// Regression test for the fix wave: index.ts's unhandledRejection/uncaughtException
// handlers must actually terminate the process in production, not just set
// process.exitCode. Registering these listeners disables Node's default
// crash-on-fatal-error behavior, and exitCode only takes effect when the process
// exits on its own — this server never does (app.listen() + cron jobs run forever) —
// so without a real process.exit() call a fatal error used to be silently swallowed
// and the process would limp along indefinitely instead of restarting via systemd.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type CrashHandler = (...args: unknown[]) => void;

describe("crash handlers registered by index.ts", () => {
  const ORIGINAL_ENV = { ...process.env };
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  // Imports the real src/index.ts fresh (registering its real, current
  // process-level listeners) under NODE_ENV=test so none of the module's
  // NODE_ENV!=="test" side effects (app.listen(), startScheduler(), the
  // production-only CORS_ORIGIN guard) run — then hands back the exact
  // listener functions index.ts just registered, a spy on the SAME logger
  // instance those listeners close over (import("../src/lib/logger.js")
  // after index.ts has already populated vi's fresh module cache resolves
  // to that same cached instance, not a new one), and a cleanup callback so
  // the listeners don't leak onto `process` for other test files sharing
  // this worker.
  async function importIndexAndCaptureHandlers() {
    process.env.NODE_ENV = "test";
    const beforeRejection = process.listeners("unhandledRejection");
    const beforeException = process.listeners("uncaughtException");

    vi.resetModules();
    await import("../src/index.js");
    const { logger: freshLogger } = await import("../src/lib/logger.js");
    const loggerErrorSpy = vi.spyOn(freshLogger, "error").mockImplementation(() => undefined as never);

    const addedRejection = process
      .listeners("unhandledRejection")
      .filter((fn) => !beforeRejection.includes(fn)) as CrashHandler[];
    const addedException = process
      .listeners("uncaughtException")
      .filter((fn) => !beforeException.includes(fn)) as CrashHandler[];

    expect(addedRejection).toHaveLength(1);
    expect(addedException).toHaveLength(1);

    return {
      rejectionHandler: addedRejection[0],
      exceptionHandler: addedException[0],
      loggerErrorSpy,
      cleanup: () => {
        process.removeListener("unhandledRejection", addedRejection[0]);
        process.removeListener("uncaughtException", addedException[0]);
        loggerErrorSpy.mockRestore();
      },
    };
  }

  it("calls process.exit(1) after an unhandled promise rejection in production", async () => {
    const { rejectionHandler, loggerErrorSpy, cleanup } = await importIndexAndCaptureHandlers();
    try {
      process.env.NODE_ENV = "production";

      rejectionHandler(new Error("boom"), Promise.resolve());

      // Exit happens on a short delay (to let the log line flush), not synchronously.
      expect(exitSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(loggerErrorSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("calls process.exit(1) after an uncaught exception in production", async () => {
    const { exceptionHandler, loggerErrorSpy, cleanup } = await importIndexAndCaptureHandlers();
    try {
      process.env.NODE_ENV = "production";

      exceptionHandler(new Error("boom"));

      expect(exitSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(loggerErrorSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("does not call process.exit outside production", async () => {
    const { rejectionHandler, exceptionHandler, cleanup } = await importIndexAndCaptureHandlers();
    try {
      // NODE_ENV stays "test" here — neither handler should ever reach for exit.
      rejectionHandler(new Error("boom"), Promise.resolve());
      exceptionHandler(new Error("boom"));
      vi.advanceTimersByTime(1000);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
