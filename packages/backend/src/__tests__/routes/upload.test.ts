import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createAppState, useLoopbackState } from "../helpers/app-state.js";
import { WRITE_CHUNK_BYTES } from "@reins/node-protocol";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { SEEDED_NODE_ID } from "../helpers/loopback-node.js";

function makeUploadRequest(
  path: string,
  files: { name: string; filename: string; content: string | Uint8Array }[],
): Request {
  const formData = new FormData();
  for (const f of files) {
    const blob =
      typeof f.content === "string"
        ? new Blob([f.content], { type: "text/plain" })
        : new Blob([new Uint8Array(f.content)], { type: "application/octet-stream" });
    formData.append(f.name, blob, f.filename);
  }
  return makeRequest(path, { method: "POST", body: formData });
}

describe("upload routes", () => {
  let state: ReturnType<typeof createAppState>;
  let router: ReturnType<typeof buildRouter>;

  useTestDb();
  const repo = useTestRepo();
  // Uploads are written into the checkout on its node.
  const loopback = useLoopbackState();

  /** The upload route for the test repo on the seeded node. */
  const upload = (query = "", { nodeId = SEEDED_NODE_ID, root }: { nodeId?: string; root?: string } = {}) =>
    `/api/nodes/${nodeId}/files/upload?root=${encodeURIComponent(root ?? repo.dir)}${query && `&${query}`}`;

  beforeEach(() => {
    state = loopback.state;
    router = buildRouter();
  });

  describe("POST /api/nodes/:nodeId/files/upload", () => {
    test("uploads under the root it names", async () => {
      const elsewhere = mkdtempSync(join(tmpdir(), "reins-upload-"));
      try {
        const res = await router.handle(
          makeUploadRequest(upload("", { root: elsewhere }), [{ name: "files", filename: "notes.txt", content: "here" }]),
          state,
        );

        expect(res!.status).toBe(200);
        expect(readFileSync(join(elsewhere, "notes.txt"), "utf-8")).toBe("here");
        expect(existsSync(join(repo.dir, "notes.txt"))).toBe(false);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    test("uploads a single file to the root", async () => {
      const res = await router.handle(
        makeUploadRequest(upload(), [
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
        makeUploadRequest(upload(), [
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
        makeUploadRequest(upload(`path=subdir`), [
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
        makeUploadRequest(upload(`path=a/b/c`), [
          { name: "files", filename: "deep.txt", content: "deep" },
        ]),
        state,
      );
      expect(res!.status).toBe(200);
      expect(readFileSync(join(repo.dir, "a", "b", "c", "deep.txt"), "utf-8")).toBe("deep");
    });

    test("rejects path traversal in query param", async () => {
      const res = await router.handle(
        makeUploadRequest(upload(`path=../../etc`), [
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
        makeUploadRequest(upload(), [
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
      const req = makeRequest(upload(), {
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
        makeUploadRequest(upload(), [
          { name: "files", filename: "data.bin", content },
        ]),
        state,
      );
      expect(res!.status).toBe(200);
      const written = readFileSync(join(repo.dir, "data.bin"), "utf-8");
      expect(written).toBe(content);
    });

    test("writes a file larger than one chunk whole, leaving nothing beside it", async () => {
      const content = Array.from({ length: 3 * WRITE_CHUNK_BYTES / 16 }, (_, i) => `line ${String(i).padStart(9, "0")}\n`).join("");
      expect(content.length).toBeGreaterThan(2 * WRITE_CHUNK_BYTES);
      const res = await router.handle(
        makeUploadRequest(upload(`path=big`), [
          { name: "files", filename: "big.txt", content },
        ]),
        state,
      );
      expect(res!.status).toBe(200);
      expect(readFileSync(join(repo.dir, "big", "big.txt"), "utf-8")).toBe(content);
      expect(readdirSync(join(repo.dir, "big"))).toEqual(["big.txt"]);
    });

    test("with the node offline, answers 503", async () => {
      const offline = createAppState();
      const res = await router.handle(
        makeUploadRequest(upload(), [
          { name: "files", filename: "test.txt", content: "test" },
        ]),
        offline,
      );
      expect(res!.status).toBe(503);
      offline.nodes.close();
    });

    test("returns 404 for an unknown node", async () => {
      const res = await router.handle(
        makeUploadRequest(upload("", { nodeId: "missing" }), [
          { name: "files", filename: "test.txt", content: "test" },
        ]),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });
});
