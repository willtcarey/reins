import { describe, expect, test } from "bun:test";
import { localIsoTime, logger, logLevelForEnv } from "../logger.js";

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

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\] unexpected condition$/);
  });

  test("a line's time is the server's local time", () => {
    const at = new Date(2026, 10, 12, 9, 5, 3, 7);

    const time = localIsoTime(at);

    expect(time).toBe("2026-11-12T09:05:03.007");
    expect(new Date(time).getTime()).toBe(at.getTime());
  });
});
