import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { buildApiObject } from "../../scripting/api-registry.js";
import { TaskSchema } from "../../scripting/tasks.js";
import { createProject } from "../project-fixture.js";
import { createTask, getTask } from "../../task-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { useLoopbackState } from "../helpers/app-state.js";
import { scriptContext } from "../helpers/script-context.js";

describe("api.tasks across projects", () => {
  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();

  test("creates and lists tasks in another project, and in the caller's by default", async () => {
    const home = createProject("Home", repo.dir, "main");
    const other = createProject("Other", `${repo.dir}-other`, "main");
    const api = buildApiObject(scriptContext(loopback.state, { projectId: home.id }));

    const created = Value.Parse(TaskSchema, await api.tasks.create("Elsewhere", "Work there", "task/elsewhere", other.id));
    const local = Value.Parse(TaskSchema, await api.tasks.create("Here", "Work here"));

    expect(created).toMatchObject({ project_id: other.id, title: "Elsewhere", branch_name: "task/elsewhere" });
    expect(local).toMatchObject({ project_id: home.id, title: "Here" });
    const ids = async (...args: unknown[]) => Value.Parse(Type.Array(TaskSchema), await api.tasks.list(...args)).map(task => task.id);
    expect(await ids(undefined, other.id)).toEqual([created.id]);
    expect(await ids()).toEqual([local.id]);
  });

  test("gets, updates, closes and reopens a task of another project by its ID", async () => {
    const home = createProject("Home", repo.dir, "main");
    const other = createProject("Other", `${repo.dir}-other`, "main");
    const task = createTask(other.id, "Foreign", null, "task/foreign");
    const api = buildApiObject(scriptContext(loopback.state, { projectId: home.id }));

    expect(await api.tasks.get(task.id)).toMatchObject({ id: task.id, project_id: other.id });
    expect(await api.tasks.update(task.id, { title: "Renamed" })).toMatchObject({ title: "Renamed" });
    expect(await api.tasks.close(task.id)).toMatchObject({ status: "closed" });
    expect(await api.tasks.reopen(task.id)).toMatchObject({ status: "open" });
    expect(getTask(task.id)).toMatchObject({ project_id: other.id, title: "Renamed", status: "open" });
  });

  test("a session of no project uses tasks by naming a project", async () => {
    const other = createProject("Other", `${repo.dir}-other`, "main");
    const api = buildApiObject(scriptContext(loopback.state));

    const created = Value.Parse(TaskSchema, await api.tasks.create("From nowhere", "Work", undefined, other.id));

    expect(created).toMatchObject({ project_id: other.id });
    expect(await api.tasks.get(created.id)).toMatchObject({ id: created.id });
    expect(() => api.tasks.list()).toThrow("This session has no project, and tasks belong to projects");
  });
});
