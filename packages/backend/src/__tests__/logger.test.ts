import { describe, expect, test } from "bun:test";
import { logger, logLevelForEnv } from "../logger.js";

function captureConsole(method: "log" | "warn", fn: () => void): string[] {
  const original = console[method];
  const logs: string[] = [];

  console[method] = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    fn();
  } finally {
    console[method] = original;
  }

  return logs;
}

describe("logger", () => {
  test("defaults routine logs to quiet while tests are running", () => {
    expect(logLevelForEnv({ NODE_ENV: "test" })).toBe("warn");
  });

  test("defaults routine logs to visible outside tests", () => {
    expect(logLevelForEnv({ NODE_ENV: "development" })).toBe("info");
  });

  test("allows explicit log level overrides outside tests", () => {
    expect(logLevelForEnv({ NODE_ENV: "development", REINS_LOG_LEVEL: "debug" })).toBe("debug");
  });

  test("keeps routine logs hidden during tests even with an info override", () => {
    expect(logLevelForEnv({ NODE_ENV: "test", REINS_LOG_LEVEL: "info" })).toBe("warn");
  });

  test("suppresses info logs under the test runner", () => {
    const logs = captureConsole("log", () => logger.info("routine lifecycle log"));

    expect(logs).toEqual([]);
  });

  test("keeps warnings visible under the test runner", () => {
    const logs = captureConsole("warn", () => logger.warn("unexpected condition"));

    expect(logs).toEqual(["unexpected condition"]);
  });
});
