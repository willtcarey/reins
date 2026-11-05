import { describe, expect, test } from "bun:test";
import { Models } from "../../models/models.js";
import { SessionInstance } from "../../sessions/session-instance.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createTask } from "../../task-store.js";
import { useLoopbackState } from "../helpers/app-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { getDb } from "../../app-globals.js";
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

  test("create_task's session starts in the task on the caller's source with the default model, and is prompted there", async () => {
    const project = createProject("Children", repo.dir);
    const caller = createSession("caller", project.id, withModel());
    const task = createTask(project.id, "Task", null, "task/children");
    setSetting("default_model", { provider: model.model.provider, modelId: model.model.modelId, runtimeType: "pi", thinkingLevel: "low" });

    const { sessionId } = await new SessionInstance(new Models(loopback.state), "caller").startTaskSession(task.id, "Task work");

    expect(getSession(sessionId)).toMatchObject({ source_id: caller.source_id, task_id: task.id, parent_session_id: null, thinking_level: "low" });
    expect(inputsOf(sessionId)).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Task work" }] })]);
  });
});
