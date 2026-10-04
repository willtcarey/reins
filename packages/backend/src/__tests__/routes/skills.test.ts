import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { connectLoopbackNode, connectScriptedNode, loopbackLink, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import type { ServerState } from "../../state.js";
import type { SkillsListResponse } from "../../routes/skills.js";

describe("GET /api/projects/:id/skills", () => {
  let state: ServerState;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    state = createServerState();
    router = buildRouter();
    projectId = createProject("Test Project", repo.dir).id;
  });
  afterEach(async () => { await stopLoopbackNode(state); state.nodes.close(); });

  function writeProjectSkill(name: string, description: string): void {
    const skillDir = join(repo.dir, ".agents", "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}`, "utf-8");
  }
  const skills = async (): Promise<SkillsListResponse> => {
    const res = await router.handle(makeRequest("GET", `/api/projects/${projectId}/skills`), state);
    expect(res!.status).toBe(200);
    return res!.json();
  };

  test("the node of the project's default source lists the skills of its checkout: name and description only", async () => {
    const uniqueName = `test-skill-${Date.now()}`;
    writeProjectSkill(uniqueName, "Test description");
    connectLoopbackNode(state);
    await loopbackLink(state).ready();

    const body = await skills();
    expect(body.available).toBe(true);
    expect(body.skills.find(skill => skill.name === uniqueName)).toEqual({ name: uniqueName, description: "Test description" });
  });

  test("with the node offline the list is empty and flagged unavailable, not an error", async () => {
    writeProjectSkill("offline-skill", "Not reachable");
    expect(await skills()).toEqual({ skills: [], available: false });
  });

  test("a node that goes away without answering, or refuses, is unavailable too", async () => {
    const link = connectScriptedNode(state, SEEDED_NODE_ID, { listSkills: () => { link.stop(); return new Promise<never>(() => {}); } });
    await link.ready();
    expect(await skills()).toEqual({ skills: [], available: false });

    const refusing = connectScriptedNode(state, SEEDED_NODE_ID, { listSkills: async () => { throw new Error("no checkout"); } });
    await refusing.ready();
    expect(await skills()).toEqual({ skills: [], available: false });
    refusing.stop();
  });

  test("returns 404 for a missing project", async () => {
    const res = await router.handle(makeRequest("GET", "/api/projects/99999/skills"), state);
    expect(res!.status).toBe(404);
  });
});
