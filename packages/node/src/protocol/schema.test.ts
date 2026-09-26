import { test, expect } from "bun:test";
import { helloParams, readyResult, provisionParams, sessionEventParams, sessionStartedParams, sessionSettledParams, scriptExecuteParams, scriptSearchParams, projectCreateTaskParams, methods } from "./schema.js";

test("version ranges and capabilities are validated at the wire boundary", () => {
  expect(helloParams.safeParse({ minVersion: 3, maxVersion: 1, instanceId: "n", capabilities: ["session.status"] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, instanceId: "n", capabilities: ["session.status", "future.optional"] }).success).toBe(true);
  expect(readyResult.safeParse({ version: 2, capabilities: ["session.status"], epoch: crypto.randomUUID() }).success).toBe(false);
  expect(readyResult.safeParse({ version: 1, capabilities: ["arbitrary.command"], epoch: crypto.randomUUID() }).success).toBe(false);
});

test("provision only accepts a scoped binding and stable command ID", () => {
  expect(provisionParams.safeParse({ epoch: crypto.randomUUID(), sessionId: "s", commandId: "c", binding: { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null }, shell: "rm -rf /" }).success).toBe(false);
  expect(provisionParams.safeParse({ epoch: crypto.randomUUID(), sessionId: "s", commandId: "c", binding: { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null } }).success).toBe(true);
});

test("run lifecycle is a durable report, not a session event", () => {
  const epoch = crypto.randomUUID();
  const event = (value: unknown) => sessionEventParams.safeParse({ epoch, sessionId: "s", seq: 1, event: value }).success;
  expect(event({ type: "agent_end" })).toBe(true);
  expect(event({ type: "run_started", runId: "r" })).toBe(false);
  expect(event({ type: "run_settled", runId: "r", status: "completed", metadata: { model: null, thinkingLevel: null }, reply: null })).toBe(false);
  expect(sessionStartedParams.safeParse({ epoch, sessionId: "s", runId: "r" }).success).toBe(true);
  const settled = { epoch, sessionId: "s", runId: "r", status: "completed", metadata: { model: null, thinkingLevel: null }, reply: null };
  expect(sessionSettledParams.safeParse(settled).success).toBe(true);
  expect(sessionSettledParams.safeParse({ ...settled, replyError: "unreadable" }).success).toBe(true);
  expect(sessionSettledParams.safeParse({ ...settled, status: "running" }).success).toBe(false);
});

test("agent tool calls carry only the calling session, never a project or task scope", () => {
  const epoch = crypto.randomUUID();
  expect(methods).toMatchObject({ scriptExecute: "script.execute", scriptSearch: "script.search", projectCreateTask: "project.createTask" });
  expect(scriptExecuteParams.safeParse({ epoch, sessionId: "s", callId: "c", code: "return 1" }).success).toBe(true);
  expect(scriptExecuteParams.safeParse({ epoch, sessionId: "s", callId: "c", code: "return 1", projectId: 2 }).success).toBe(false);
  expect(scriptSearchParams.safeParse({ epoch, sessionId: "s", query: "", taskId: 3 }).success).toBe(false);
  expect(projectCreateTaskParams.safeParse({ epoch, sessionId: "s", title: "t", description: "d", projectId: 2 }).success).toBe(false);
  expect(projectCreateTaskParams.safeParse({ epoch, sessionId: "s", title: "t", description: "d", branchName: "task/t", prompt: "go" }).success).toBe(true);
});
