import { describe, test, expect, beforeEach, mock } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo, commitFile } from "../helpers/test-repo.js";
import { createProject } from "../../project-store.js";
import { ProjectModel } from "../../models/projects.js";
import { Sessions } from "../../models/sessions.js";
import { Workspace } from "../../models/workspace.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";

describe("ProjectModel scoped models", () => {
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test", repo.dir, "main");
    const broadcastSpy: Broadcast = mock<(msg: ServerMessage) => void>();
    const sessions = new Map<string, ManagedSession>();
    model = new ProjectModel(project.id, sessions, broadcastSpy);
  });

  test("returns a Sessions instance", () => {
    expect(model.sessions).toBeInstanceOf(Sessions);
  });

  test("returns a Workspace instance scoped to the project checkout", () => {
    expect(model.workspace).toBeInstanceOf(Workspace);
    expect(model.workspace.projectDir).toBe(repo.dir);
    expect(model.workspace.baseBranch).toBe("main");
  });
});

describe("ProjectModel.listFiles", () => {
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test", repo.dir, "main");
    const broadcastSpy: Broadcast = mock<(msg: ServerMessage) => void>();
    const sessions = new Map<string, ManagedSession>();
    model = new ProjectModel(project.id, sessions, broadcastSpy);
  });

  test("returns tracked files", async () => {
    const files = await model.listFiles();
    expect(files).toContain("README.md");
  });

  test("includes untracked non-ignored files", async () => {
    writeFileSync(join(repo.dir, "new-file.ts"), "export {}");
    const files = await model.listFiles();
    expect(files).toContain("new-file.ts");
  });

  test("excludes gitignored files", async () => {
    await commitFile(repo.dir, ".gitignore", "ignored.log\n", "add gitignore");
    writeFileSync(join(repo.dir, "ignored.log"), "secret");
    const files = await model.listFiles();
    expect(files).not.toContain("ignored.log");
    expect(files).toContain(".gitignore");
  });

  test("includes files in subdirectories", async () => {
    mkdirSync(join(repo.dir, "src"), { recursive: true });
    await commitFile(repo.dir, "src/index.ts", "console.log('hi')", "add src");
    const files = await model.listFiles();
    expect(files).toContain("src/index.ts");
  });

  test("returns sorted deduplicated list", async () => {
    writeFileSync(join(repo.dir, "b.txt"), "b");
    writeFileSync(join(repo.dir, "a.txt"), "a");
    const files = await model.listFiles();
    const sorted = [...files].toSorted();
    expect(files).toEqual(sorted);
  });
});
