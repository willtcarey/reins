import { expect, test } from "bun:test";
import { setupTestDb, teardownTestDb } from "./test-db.js";

function captureMigrationLogs(fn: () => void): string[] {
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

  return logs.filter((line) => line.includes("Migration applied:"));
}

function setupAndTeardownTestDb(): void {
  setupTestDb();
  teardownTestDb();
}

test("setupTestDb reuses the migrated template after first setup", () => {
  captureMigrationLogs(setupAndTeardownTestDb);

  const secondSetupMigrationLogs = captureMigrationLogs(setupAndTeardownTestDb);

  expect(secondSetupMigrationLogs).toEqual([]);
});
