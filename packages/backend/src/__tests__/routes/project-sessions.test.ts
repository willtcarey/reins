import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";

function makeRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("project session routes", () => {
  let state: ReturnType<typeof createTestState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    state = createTestState();
    router = buildRouter();
    const p = createProject("Test Project", repo.dir);
    projectId = p.id;
  });

  describe("GET /api/projects/:id/sessions", () => {
    test("returns empty list when no sessions", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/sessions`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });

    test("returns scratch sessions (excludes task sessions)", async () => {
      createSession("scratch-1", projectId, {});

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/sessions`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("scratch-1");
    });
  });
});
