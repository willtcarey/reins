import { expect, test } from "bun:test";
import { setupTestDb, teardownTestDb } from "./test-db.js";

function captureConsoleLogs(fn: () => void): string[] {
  const originalLog = console.log;
  const logs: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    fn();
  } finally {
    console.log = originalLog;
  }

  return logs;
}

function setupAndTeardownTestDb(): void {
  setupTestDb();
  teardownTestDb();
}

test("setupTestDb does not print migration logs during routine test setup", () => {
  const logs = captureConsoleLogs(setupAndTeardownTestDb);

  expect(logs).toEqual([]);
});
