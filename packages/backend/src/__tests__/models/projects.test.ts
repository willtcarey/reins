import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createServerState } from "../helpers/server-state.js";
import { createProject } from "../../project-store.js";
import { ProjectModel, resolveSource, SourceNotFoundError } from "../../models/projects.js";
import { createSource, defaultSource } from "../../node-store.js";
import { getDb } from "../../db.js";
import { Workspace } from "../../models/workspace.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";

describe("ProjectModel scoped models", () => {
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test", repo.dir, "main");
    const broadcastSpy: Broadcast = mock<(msg: ServerMessage) => void>();
    model = new ProjectModel(project.id, broadcastSpy, createServerState().nodes, defaultSource(project.id)!);
  });

  test("returns a Workspace instance scoped to the project checkout", () => {
    expect(model.workspace).toBeInstanceOf(Workspace);
    expect(model.workspace.projectDir).toBe(repo.dir);
    expect(model.workspace.baseBranch).toBe("main");
  });
});

describe("resolveSource", () => {
  useTestDb();

  test("is the named source of the project, else the project's default source", () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const project = createProject("Test", "/checkouts/test", "main");
    const remote = createSource(project.id, "remote", "/remote/test");

    expect(resolveSource(project.id, remote.id)).toEqual(remote);
    expect(resolveSource(project.id)).toEqual(defaultSource(project.id)!);
    expect(resolveSource(project.id, null)).toEqual(defaultSource(project.id)!);
  });

  test("refuses a source of another project, or none", () => {
    const project = createProject("Test", "/checkouts/test", "main");
    const other = createProject("Other", "/checkouts/other", "main");

    expect(() => resolveSource(project.id, defaultSource(other.id)!.id)).toThrow(SourceNotFoundError);
    expect(() => resolveSource(project.id, 99_999)).toThrow(SourceNotFoundError);
  });
});
