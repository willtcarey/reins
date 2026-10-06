import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createServerState } from "../helpers/server-state.js";
import { createProject } from "../project-fixture.js";
import { ProjectModel } from "../../models/projects.js";
import { SourceModel } from "../../models/sources.js";
import { defaultSource } from "../../node-store.js";
import { Workspace } from "../../models/workspace.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";

describe("ProjectModel scoped models", () => {
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test", repo.dir, "main");
    const broadcastSpy: Broadcast = mock<(msg: ServerMessage) => void>();
    model = new ProjectModel(project.id, broadcastSpy, new SourceModel(createServerState().nodes, defaultSource(project.id)!));
  });

  test("returns a Workspace of its source's checkout, against the project's base branch", () => {
    expect(model.workspace).toBeInstanceOf(Workspace);
    expect(model.workspace.root).toBe(repo.dir);
    expect(model.workspace.baseBranch).toBe("main");
  });
});
