import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";

describe("GET /api/projects/:id/skills", () => {
  let state: ReturnType<typeof createServerState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    state = createServerState();
    router = buildRouter();
    const p = createProject("Test Project", repo.dir);
    projectId = p.id;
  });

  function writeProjectSkill(name: string, description: string): void {
    const skillDir = join(repo.dir, ".agents", "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}`,
      "utf-8",
    );
  }

  test("returns the skills array", async () => {
    const res = await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/skills`),
      state,
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(Array.isArray(body.skills)).toBe(true);
  });

  test("includes project-level skills with name and description only", async () => {
    const uniqueName = `test-skill-${Date.now()}`;
    writeProjectSkill(uniqueName, "Test description");

    const res = await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/skills`),
      state,
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    const found = body.skills.find((s: { name: string }) => s.name === uniqueName);
    expect(found).toBeDefined();
    expect(found.description).toBe("Test description");
    expect(Object.keys(found).toSorted()).toEqual(["description", "name"]);
  });

  test("returns 404 for a missing project", async () => {
    const res = await router.handle(
      makeRequest("GET", "/api/projects/99999/skills"),
      state,
    );
    expect(res!.status).toBe(404);
  });
});
