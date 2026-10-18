import { test, expect } from "bun:test";
import { helloParams, helloResult, protocolVersion, readyResult } from "./negotiation.js";

test("version ranges are validated at the wire boundary; a ready reply is only its version", () => {
  expect(helloParams.safeParse({ minVersion: 3, maxVersion: 1, nodeId: "n" }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2 }).success).toBe(false);
  expect(readyResult.safeParse({ kind: "ready", version: protocolVersion + 1 }).success).toBe(false);
  expect(helloResult.parse({ kind: "ready", version: protocolVersion })).toEqual({ kind: "ready", version: protocolVersion });
});

test("the hello envelope is parsed tolerantly: fields the server does not read are dropped, and a bundled node announces its build", () => {
  const hello = { minVersion: 1, maxVersion: 2, nodeId: "n" };
  expect(helloParams.parse({ ...hello, buildId: "a".repeat(64), fromTheFuture: { anything: true } })).toEqual({ ...hello, buildId: "a".repeat(64) });
  // A node before protocol 12 lists its live sessions, and one before protocol 15 its capabilities; nothing reads them now.
  expect(helloParams.parse({ ...hello, liveSessions: ["s1", "s2"], capabilities: ["pi.exec", "future.optional"] })).toEqual(hello);
  // The build ID is the sha256 of the node's bundle.
  expect(helloParams.safeParse({ ...hello, buildId: "not-a-build" }).success).toBe(false);
  // From protocol 13 a node says where its REINS docs are.
  expect(helloParams.parse({ ...hello, docs: { dir: "/opt/reins/docs", devDocs: false } })).toEqual({ ...hello, docs: { dir: "/opt/reins/docs", devDocs: false } });
});

test("the server's replies are checked as it sends them", () => {
  expect(helloResult.safeParse({ kind: "update", buildId: "b".repeat(64), sha256: "b".repeat(64), bunVersion: "1.3.9" }).success).toBe(true);
  expect(helloResult.safeParse({ kind: "error", code: "bootstrap_unsupported", message: "Reinstall this node" }).success).toBe(true);
  expect(helloResult.safeParse({ kind: "update", buildId: "b".repeat(64), sha256: "b".repeat(64) }).success).toBe(false);
  expect(helloResult.safeParse({ kind: "later" }).success).toBe(false);
});
