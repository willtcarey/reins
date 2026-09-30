import { test, expect } from "bun:test";
import { helloParams, MAX_LIVE_SESSIONS, protocolVersion, readyResult } from "./node-connection.js";

test("version ranges and capabilities are validated at the wire boundary", () => {
  expect(helloParams.safeParse({ minVersion: 3, maxVersion: 1, nodeId: "n", capabilities: ["session.prompt"], liveSessions: [] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: ["session.prompt", "future.optional"], liveSessions: [] }).success).toBe(true);
  // Crash recovery: the node lists the sessions it has a run in progress for, bounded.
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [], liveSessions: ["s1", "s2"] }).success).toBe(true);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [], liveSessions: Array.from({ length: MAX_LIVE_SESSIONS + 1 }, (_, i) => `s${i}`) }).success).toBe(false);
  expect(readyResult.safeParse({ version: protocolVersion + 1, capabilities: ["session.prompt"], epoch: crypto.randomUUID() }).success).toBe(false);
  expect(readyResult.safeParse({ version: protocolVersion, capabilities: ["arbitrary.command"], epoch: crypto.randomUUID() }).success).toBe(false);
});
