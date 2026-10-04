import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createProject } from "../../project-store.js";
import { ProjectModel } from "../../models/projects.js";
import { Workspace } from "../../models/workspace.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";

describe("ProjectModel scoped models", () => {
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test", repo.dir, "main");
    const broadcastSpy: Broadcast = mock<(msg: ServerMessage) => void>();
    model = new ProjectModel(project.id, broadcastSpy);
  });

  test("returns a Workspace instance scoped to the project checkout", () => {
    expect(model.workspace).toBeInstanceOf(Workspace);
    expect(model.workspace.projectDir).toBe(repo.dir);
    expect(model.workspace.baseBranch).toBe("main");
  });
});
