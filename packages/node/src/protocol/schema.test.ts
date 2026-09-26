import { test, expect } from "bun:test";
import { helloParams, readyResult, provisionParams } from "./schema.js";

test("version ranges and capabilities are validated at the wire boundary", () => {
  expect(helloParams.safeParse({ minVersion: 3, maxVersion: 1, instanceId: "n", capabilities: ["node.status"] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, instanceId: "n", capabilities: ["node.status", "future.optional"] }).success).toBe(true);
  expect(readyResult.safeParse({ version: 2, capabilities: ["node.status"], epoch: crypto.randomUUID() }).success).toBe(false);
  expect(readyResult.safeParse({ version: 1, capabilities: ["arbitrary.command"], epoch: crypto.randomUUID() }).success).toBe(false);
});

test("provision only accepts a scoped binding and stable command ID", () => {
  expect(provisionParams.safeParse({ epoch: crypto.randomUUID(), sessionId: "s", commandId: "c", binding: { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null }, shell: "rm -rf /" }).success).toBe(false);
  expect(provisionParams.safeParse({ epoch: crypto.randomUUID(), sessionId: "s", commandId: "c", binding: { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null } }).success).toBe(true);
});
