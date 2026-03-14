import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";

function makeUploadRequest(
  path: string,
  files: { name: string; filename: string; content: string | Uint8Array }[],
): Request {
  const formData = new FormData();
  for (const f of files) {
    const blob =
      typeof f.content === "string"
        ? new Blob([f.content], { type: "text/plain" })
        : new Blob([f.content], { type: "application/octet-stream" });
    formData.append(f.name, blob, f.filename);
  }
  return new Request(`http://localhost${path}`, { method: "POST", body: formData });
}

describe("upload routes", () => {
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

  describe("POST /api/projects/:id/upload", () => {
    test("uploads a single file to the project root", async () => {
      const res = await router.handle(
        makeUploadRequest(`/api/projects/${projectId}/upload`, [
          { name: "files", filename: "hello.txt", content: "hello world" },
        ]),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.uploaded).toEqual(["hello.txt"]);
      expect(readFileSync(join(repo.dir, "hello.txt"), "utf-8")).toBe("hello world");
    });

    test("uploads multiple files", async () => {
      const res = await router.handle(
        makeUploadRequest(`/api/projects/${projectId}/upload`, [
          { name: "files", filename: "a.txt", content: "aaa" },
          { name: "files", filename: "b.txt", content: "bbb" },
        ]),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.uploaded).toHaveLength(2);
      expect(body.uploaded).toContain("a.txt");
      expect(body.uploaded).toContain("b.txt");
      expect(readFileSync(join(repo.dir, "a.txt"), "utf-8")).toBe("aaa");
      expect(readFileSync(join(repo.dir, "b.txt"), "utf-8")).toBe("bbb");
    });

    test("uploads to a subdirectory via ?path= query param", async () => {
      const res = await router.handle(
        makeUploadRequest(`/api/projects/${projectId}/upload?path=subdir`, [
          { name: "files", filename: "nested.txt", content: "nested" },
        ]),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.uploaded).toEqual(["subdir/nested.txt"]);
      expect(readFileSync(join(repo.dir, "subdir", "nested.txt"), "utf-8")).toBe("nested");
    });

    test("creates intermediate directories", async () => {
      const res = await router.handle(
        makeUploadRequest(`/api/projects/${projectId}/upload?path=a/b/c`, [
          { name: "files", filename: "deep.txt", content: "deep" },
        ]),
        state,
      );
      expect(res!.status).toBe(200);
      expect(readFileSync(join(repo.dir, "a", "b", "c", "deep.txt"), "utf-8")).toBe("deep");
    });

    test("rejects path traversal in query param", async () => {
      const res = await router.handle(
        makeUploadRequest(`/api/projects/${projectId}/upload?path=../../etc`, [
          { name: "files", filename: "evil.txt", content: "pwned" },
        ]),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("traversal");
    });

    test("sanitizes path traversal in filename by using basename", async () => {
      const res = await router.handle(
        makeUploadRequest(`/api/projects/${projectId}/upload`, [
          { name: "files", filename: "../../../etc/passwd", content: "safe content" },
        ]),
        state,
      );
      // basename("../../../etc/passwd") → "passwd", written safely to project root
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.uploaded).toEqual(["passwd"]);
      expect(readFileSync(join(repo.dir, "passwd"), "utf-8")).toBe("safe content");
      // Verify it did NOT write outside the project
      expect(existsSync("/etc/passwd_test_marker")).toBe(false);
    });

    test("returns 400 when no files are provided", async () => {
      const formData = new FormData();
      const req = new Request(`http://localhost/api/projects/${projectId}/upload`, {
        method: "POST",
        body: formData,
      });
      const res = await router.handle(req, state);
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("No files");
    });

    test("uploads binary content correctly", async () => {
      // Use a string with special chars to verify binary-safe writing
      // (Bun has issues round-tripping Uint8Array through FormData in tests)
      const content = "binary\x01\x02\x03content";
      const res = await router.handle(
        makeUploadRequest(`/api/projects/${projectId}/upload`, [
          { name: "files", filename: "data.bin", content },
        ]),
        state,
      );
      expect(res!.status).toBe(200);
      const written = readFileSync(join(repo.dir, "data.bin"), "utf-8");
      expect(written).toBe(content);
    });

    test("returns 404 for nonexistent project", async () => {
      const res = await router.handle(
        makeUploadRequest(`/api/projects/9999/upload`, [
          { name: "files", filename: "test.txt", content: "test" },
        ]),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });
});
