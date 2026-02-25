import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";

function makeRequest(method: string, path: string, body?: any): Request {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, opts);
}

describe("project routes", () => {
  let state: ReturnType<typeof createTestState>;
  let router: ReturnType<typeof buildRouter>;
  let tempDir: string;

  useTestDb();

  beforeEach(() => {
    state = createTestState();
    router = buildRouter();
    tempDir = mkdtempSync(join(tmpdir(), "reins-test-projects-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("GET /api/projects", () => {
    test("returns empty list when no projects", async () => {
      const res = await router.handle(makeRequest("GET", "/api/projects"), state);
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });

    test("returns all created projects", async () => {
      createProject("First", tempDir);
      const res = await router.handle(makeRequest("GET", "/api/projects"), state);
      const body = await res!.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("First");
    });
  });

  describe("POST /api/projects", () => {
    test("creates a project and returns 201", async () => {
      const res = await router.handle(
        makeRequest("POST", "/api/projects", { name: "Test", path: tempDir }),
        state,
      );
      expect(res!.status).toBe(201);
      const body = await res!.json();
      expect(body.name).toBe("Test");
      expect(body.path).toBe(tempDir);
      expect(body.id).toBeGreaterThan(0);
    });

    test("returns 400 when name is missing", async () => {
      const res = await router.handle(
        makeRequest("POST", "/api/projects", { path: tempDir }),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("name");
    });

    test("returns 400 when path is missing", async () => {
      const res = await router.handle(
        makeRequest("POST", "/api/projects", { name: "Test" }),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("returns 400 when path does not exist", async () => {
      const res = await router.handle(
        makeRequest("POST", "/api/projects", { name: "Test", path: "/tmp/nonexistent-path-xyz" }),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("does not exist");
    });

    test("returns 409 on duplicate path", async () => {
      createProject("First", tempDir);
      const res = await router.handle(
        makeRequest("POST", "/api/projects", { name: "Second", path: tempDir }),
        state,
      );
      expect(res!.status).toBe(409);
      const body = await res!.json();
      expect(body.error).toContain("already exists");
    });
  });

  describe("PATCH /api/projects/:id", () => {
    test("updates a project name", async () => {
      const p = createProject("Original", tempDir);
      const res = await router.handle(
        makeRequest("PATCH", `/api/projects/${p.id}`, { name: "Updated" }),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.name).toBe("Updated");
    });

    test("returns 404 for nonexistent project", async () => {
      const res = await router.handle(
        makeRequest("PATCH", "/api/projects/9999", { name: "Nope" }),
        state,
      );
      expect(res!.status).toBe(404);
    });

    test("returns 400 for empty name", async () => {
      const p = createProject("Original", tempDir);
      const res = await router.handle(
        makeRequest("PATCH", `/api/projects/${p.id}`, { name: "  " }),
        state,
      );
      expect(res!.status).toBe(400);
    });
  });

  describe("DELETE /api/projects/:id", () => {
    test("deletes a project and returns ok", async () => {
      const p = createProject("ToDelete", tempDir);
      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${p.id}`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ ok: true });
    });

    test("returns 404 for nonexistent project", async () => {
      const res = await router.handle(
        makeRequest("DELETE", "/api/projects/9999"),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });
});
