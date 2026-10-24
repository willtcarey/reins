import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { until } from "../helpers/session-host.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { createAppState } from "../helpers/app-state.js";
import { getDb } from "../../app-globals.js";
import { type Project } from "../../project-store.js";
import { createProject } from "../project-fixture.js";
import { defaultSource } from "../../node-store.js";
import { createSession } from "../session-fixture.js";
import { sessionsCompactFunction } from "../../scripting/sessions.js";
import type { ApiContext } from "../../scripting/define-function.js";
import { Models } from "../../models/models.js";

const storedRoles = (sessionId: string) => getDb()
  .query<{ role: string }, [string]>("SELECT role FROM session_messages WHERE session_id = ? ORDER BY seq")
  .all(sessionId).map(row => row.role);

describe("sessions.compact", () => {
  useTestDb();
  const model = useFakeModel();
  let project: Project;

  beforeEach(() => { project = createProject("Test Project", "/tmp/test-project", "main"); });

  function makeCtx(): ApiContext {
    const state = createAppState();
    const models = new Models(state);
    return { projectId: project.id, sessionId: "ctx-session", taskId: null, sourceId: defaultSource(project.id)!.id, broadcast: models.broadcast, nodes: state.nodes, models };
  }

  test("compacts a session of the current project with the given instructions", async () => {
    createSession("idle", project.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: model.model.modelId });
    persistCanonicalMessages("idle", [
      { role: "user", content: [{ type: "text", text: "Plan the API" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Here is a plan" }], timestamp: 2 },
    ]);

    expect(await sessionsCompactFunction.execute({ sessionId: "idle", instructions: "Keep the endpoint names" }, makeCtx())).toEqual({ sessionId: "idle" });

    const summary = await model.nextSummary();
    expect(JSON.stringify(summary.context)).toContain("Keep the endpoint names");
    summary.finish({ reply: "The plan so far" });
    await until(() => storedRoles("idle").at(-1) === "compaction", "the compaction was committed");
  });

  test("refuses a session outside the current project", async () => {
    const other = createProject("Other Project", "/tmp/other-project", "main");
    createSession("elsewhere", other.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: model.model.modelId });
    persistCanonicalMessages("elsewhere", [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }]);

    await expect(sessionsCompactFunction.execute({ sessionId: "elsewhere" }, makeCtx())).rejects.toThrow("Session elsewhere is outside the current project scope");
    expect(storedRoles("elsewhere")).toEqual(["reinsInput"]);
  });
});
