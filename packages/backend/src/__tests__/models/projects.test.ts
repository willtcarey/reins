import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createAppState } from "../helpers/app-state.js";
import { createProject } from "../project-fixture.js";
import { ProjectModel, ProjectNotFoundError } from "../../models/projects.js";
import { Nodes } from "../../models/nodes.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";

describe("ProjectModel scoped models", () => {
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test", repo.dir, "main");
    const broadcastSpy: Broadcast = mock<(msg: ServerMessage) => void>();
    model = new ProjectModel(project.id, new Nodes(createAppState(), broadcastSpy));
  });

  test("an unknown project is ProjectNotFoundError", () => {
    expect(() => new ProjectModel(9999, new Nodes(createAppState(), mock()))).toThrow(ProjectNotFoundError);
  });

  test("works in its default source, against its base branch", () => {
    expect(model.defaultSource.path).toBe(repo.dir);
    expect(model.baseBranch).toBe("main");
  });
});
