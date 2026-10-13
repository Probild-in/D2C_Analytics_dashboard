import { describe, it, expect } from "vitest";
import { logger } from "../../src/lib/logger.js";

describe("logger", () => {
  it("exposes info, warn, and error methods", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("does not throw when logging a plain message and an error object", () => {
    expect(() => logger.info("test message")).not.toThrow();
    expect(() => logger.error(new Error("boom"), "test error")).not.toThrow();
  });
});
