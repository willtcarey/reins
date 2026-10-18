import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { connectLoopbackNode, connectScriptedNode, loopbackLink, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../project-fixture.js";
import type { SkillsListResponse } from "../../routes/skills.js";

const failing = async (): Promise<never> => { throw new Error("disk on fire"); };

describe("GET /api/projects/:id/skills", () => {
  let state: TestAppState;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;
  let home: string;
  let previousHome: string | undefined;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    state = createAppState();
    router = buildRouter();
    projectId = createProject("Test Project", repo.dir).id;
    // The server's own skills, in its ~/.agents: not a session's. (The loopback node's home is this test
    // process's own: Pi's `~` is `os.homedir()`, which HOME set here does not move.)
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "reins-home-"));
    process.env.HOME = home;
    writeSkill(join(home, ".agents"), "server-skill", "The server's skill");
  });
  afterEach(async () => {
    await stopLoopbackNode(state);
    await state.nodes.close();
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeSkill(agentsDir: string, name: string, description: string): void {
    const skillDir = join(agentsDir, "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}`, "utf-8");
  }
  const writeProjectSkill = (name: string, description: string) => writeSkill(join(repo.dir, ".agents"), name, description);
  const skills = async (): Promise<SkillsListResponse> => {
    const res = await router.handle(makeRequest("GET", `/api/projects/${projectId}/skills`), state);
    expect(res!.status).toBe(200);
    return res!.json();
  };

  test("lists the skills of the project's default source's node and checkout, as a session's runtime discovers them: name and description only, nothing of the server's ~/.agents", async () => {
    writeProjectSkill("checkout-skill", "The checkout's skill");
    connectLoopbackNode(state);
    await loopbackLink(state).ready();

    const listed = await skills();
    expect(listed.available).toBe(true);
    expect(listed.skills).toContainEqual({ name: "checkout-skill", description: "The checkout's skill" });
    expect(listed.skills.map(skill => skill.name)).not.toContain("server-skill");
  });

  test("with the node offline, no skills, flagged unavailable, not an error", async () => {
    writeProjectSkill("offline-skill", "Not reachable");
    expect(await skills()).toEqual({ skills: [], available: false });
  });

  test("a node that goes away without answering, or fails, is unavailable too, not taken for a node without skills", async () => {
    const away = () => { link.stop(); return new Promise<never>(() => {}); };
    const link = connectScriptedNode(state, SEEDED_NODE_ID, { fileInfo: away, readFile: away });
    await link.ready();
    expect(await skills()).toEqual({ skills: [], available: false });

    const broken = connectScriptedNode(state, SEEDED_NODE_ID, { fileInfo: failing, readFile: failing });
    await broken.ready();
    expect(await skills()).toEqual({ skills: [], available: false });
    broken.stop();
  });

  test("returns 404 for a missing project", async () => {
    const res = await router.handle(makeRequest("GET", "/api/projects/99999/skills"), state);
    expect(res!.status).toBe(404);
  });
});
