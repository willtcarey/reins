import { describe, expect, test } from "bun:test";
import { SessionInstance } from "../../sessions/session-instance.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createTask } from "../../task-store.js";
import { useLoopbackState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { getDb } from "../../db.js";
import { setSetting } from "../../settings-store.js";

/** The inputs Pi admitted for `sessionId` (transcript entries and queued steering). */
const inputsOf = (sessionId: string) => [
  ...getDb().query<{ json: string }, [string]>("SELECT json_extract(message_json, '$.message') json FROM session_messages WHERE session_id = ? AND role = 'reinsInput' ORDER BY seq").all(sessionId),
  ...getDb().query<{ json: string }, [string]>("SELECT json_extract(value_json, '$.payload') json FROM pi_values WHERE session_id = ? AND namespace = 'pi.pending.entry' AND json_extract(value_json, '$.payload.role') = 'reinsInput' ORDER BY seq").all(sessionId),
].map(({ json }): Record<string, unknown> => JSON.parse(json));

describe("SessionInstance", () => {
  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  const model = useFakeModel();
  const withModel = () => ({ agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: model.model.modelId });

  test("delivers addressed messages as steers from the sender to the target's runtime, admitted when it resolves", async () => {
    const project = createProject("Messages", repo.dir);
    createSession("source", project.id, withModel());
    createSession("target", project.id, withModel());
    const instance = new SessionInstance(loopback.state, "source");

    expect(await instance.send("target", "First")).toEqual({ sessionId: "target" });
    expect(inputsOf("target")).toEqual([{ role: "reinsInput", content: [{ type: "text", text: "First" }], reinsId: expect.any(String), metadata: { sourceSessionId: "source" }, timestamp: expect.any(Number) }]);
  });

  test("sends to another task's session in the same project; refuses one in another project", async () => {
    const project = createProject("Cross-task delivery", repo.dir);
    createSession("source", project.id, withModel());
    const task = createTask(project.id, "Other task", null, "task/other");
    createSession("target", project.id, { ...withModel(), taskId: task.id });
    const other = createProject("Target", `${repo.dir}/other`);
    createSession("stranger", other.id, withModel());

    await new SessionInstance(loopback.state, "source").send("target", "Do not break mobile");
    expect(inputsOf("target")).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Do not break mobile" }], metadata: { sourceSessionId: "source" } })]);
    await expect(new SessionInstance(loopback.state, "source").send("stranger", "Nope")).rejects.toThrow();
    expect(inputsOf("stranger")).toEqual([]);
  });

  test("child and task sessions are created on the caller's source and prompted there", async () => {
    const project = createProject("Children", repo.dir);
    const caller = createSession("caller", project.id, withModel());
    const task = createTask(project.id, "Task", null, "task/children");
    // A task session gets the default model.
    setSetting("default_model", { provider: model.model.provider, modelId: model.model.modelId, runtimeType: "pi", thinkingLevel: "low" });
    const instance = new SessionInstance(loopback.state, "caller");

    const child = await instance.start("Child work", { parentSessionId: "current" });
    const taskSession = await instance.startTaskSession(task.id, "Task work");
    for (const { sessionId } of [child, taskSession]) expect(getSession(sessionId)?.source_id).toBe(caller.source_id);
    expect(getSession(child.sessionId)?.parent_session_id).toBe("caller");
    expect(getSession(taskSession.sessionId)?.task_id).toBe(task.id);
    expect(inputsOf(child.sessionId)).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Child work" }] })]);
    expect(inputsOf(taskSession.sessionId)).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Task work" }] })]);
  });

  test("wait: a child started by its parent resolves with its settlement once it reported to its parent", async () => {
    const project = createProject("Child wait", repo.dir);
    createSession("parent", project.id, withModel());
    const instance = new SessionInstance(loopback.state, "parent");
    const { sessionId } = await instance.start("Child work", { parentSessionId: "current" });
    const waiting = instance.wait(sessionId, 10_000);
    (await model.nextTurn(sessionId)).finish({ reply: "Child result" });
    expect(await waiting).toEqual({ sessionId, status: "completed", result: "Child result", error: null });
    expect(getSession(sessionId)?.activity_state).toBeNull();
    expect(inputsOf("parent")).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Child result" }], metadata: { sourceSessionId: sessionId } })]);
  });
});
