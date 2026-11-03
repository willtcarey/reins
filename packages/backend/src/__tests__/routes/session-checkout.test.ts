import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { createTestRepo, git, useTestRepo, type TestRepo } from "../helpers/test-repo.js";
import { connectLoopbackNode, loopbackLink, stopLoopbackNode } from "../helpers/loopback-node.js";
import { buildRouter } from "../../routes/index.js";
import { getDb } from "../../app-globals.js";
import { createProject, createSourceAt } from "../project-fixture.js";
import { createSession } from "../session-fixture.js";
import { createSession as insertSession } from "../../session-store.js";

describe("checkout views of a session", () => {
  let state: TestAppState;
  let router: ReturnType<typeof buildRouter>;
  let elsewhere: TestRepo;

  useTestDb();
  const home = useTestRepo();

  beforeEach(async () => {
    state = createAppState();
    router = buildRouter();
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('laptop', 'Laptop')");
    connectLoopbackNode(state);
    connectLoopbackNode(state, { nodeId: "laptop" });
    await Promise.all([loopbackLink(state).ready(), loopbackLink(state, "laptop").ready()]);
    elsewhere = await createTestRepo();
  });
  afterEach(async () => {
    await stopLoopbackNode(state);
    await stopLoopbackNode(state, "laptop");
    await state.nodes.close();
    elsewhere.cleanup();
  });

  const get = async (path: string) => {
    const res = await router.handle(makeRequest("GET", path), state);
    return { status: res!.status, body: res!.headers.get("Content-Type")?.includes("json") ? await res!.json() : await res!.text() };
  };

  test("a session on a second node reads that node's checkout, not the project's home one", async () => {
    const projectId = createProject("Project", home.dir).id;
    writeFileSync(join(home.dir, "home-only.txt"), "home\n");
    writeFileSync(join(elsewhere.dir, "laptop-only.txt"), "laptop\n");
    await git(elsewhere.dir, ["checkout", "-b", "on-laptop"]);
    createSession("away", projectId, { agentRuntimeType: "pi", sourceId: createSourceAt(elsewhere.dir, "laptop").id });

    expect(await get("/api/sessions/away/files")).toEqual({ status: 200, body: { files: ["README.md", "laptop-only.txt"] } });
    expect(await get("/api/sessions/away/files/tree?path=.")).toEqual({ status: 200, body: { entries: [
      { name: ".git", type: "directory" },
      { name: "laptop-only.txt", type: "file" },
      { name: "README.md", type: "file" },
    ] } });
    expect(await get("/api/sessions/away/files/content?path=laptop-only.txt")).toEqual({ status: 200, body: "laptop\n" });
    expect(await get("/api/sessions/away/diff/files?mode=uncommitted")).toEqual({ status: 200, body: {
      files: [expect.objectContaining({ path: "laptop-only.txt" })],
      branch: "on-laptop",
      baseBranch: "main",
    } });
  });

  test("a session of no project reads its own checkout, its diffs against HEAD: its uncommitted work", async () => {
    writeFileSync(join(elsewhere.dir, "draft.txt"), "draft\n");
    insertSession("loose", null, { agentRuntimeType: "pi", sourceId: createSourceAt(elsewhere.dir, "laptop").id });

    expect(await get("/api/sessions/loose/files")).toEqual({ status: 200, body: { files: ["draft.txt", "README.md"].toSorted() } });
    expect(await get("/api/sessions/loose/diff/files")).toEqual({ status: 200, body: {
      files: [expect.objectContaining({ path: "draft.txt" })],
      branch: "main",
      baseBranch: "HEAD",
    } });
  });

  test("an unknown session is a 404", async () => {
    createProject("Project", home.dir);
    expect(await get("/api/sessions/missing/files")).toEqual({ status: 404, body: { error: "Session not found: missing" } });
  });
});
