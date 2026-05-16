import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo, commitFile } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

function onePixelPng(): Uint8Array {
  const fileBytes = readFileSync(join(import.meta.dir, "..", "fixtures", "one-pixel.png"));
  const bytes = new Uint8Array(new ArrayBuffer(fileBytes.byteLength));
  bytes.set(fileBytes);
  return bytes;
}

describe("file routes", () => {
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

  // ---- GET /files (listing) ------------------------------------------------

  describe("GET /api/projects/:id/files", () => {
    test("returns tracked files", async () => {
      // README.md is committed by the test repo helper
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.files).toContain("README.md");
    });

    test("includes untracked non-ignored files", async () => {
      writeFileSync(join(repo.dir, "new-file.ts"), "export {}");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files`),
        state,
      );
      const body = await res!.json();
      expect(body.files).toContain("new-file.ts");
    });

    test("excludes gitignored files", async () => {
      await commitFile(repo.dir, ".gitignore", "ignored.log\n", "add gitignore");
      writeFileSync(join(repo.dir, "ignored.log"), "secret");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files`),
        state,
      );
      const body = await res!.json();
      expect(body.files).not.toContain("ignored.log");
      expect(body.files).toContain(".gitignore");
    });

    test("includes files in subdirectories", async () => {
      mkdirSync(join(repo.dir, "src"), { recursive: true });
      await commitFile(repo.dir, "src/index.ts", "console.log('hi')", "add src");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files`),
        state,
      );
      const body = await res!.json();
      expect(body.files).toContain("src/index.ts");
    });

    test("returns sorted deduplicated list", async () => {
      writeFileSync(join(repo.dir, "b.txt"), "b");
      writeFileSync(join(repo.dir, "a.txt"), "a");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files`),
        state,
      );
      const body = await res!.json();
      const sorted = [...body.files].toSorted();
      expect(body.files).toEqual(sorted);
    });
  });

  // ---- GET /files/content --------------------------------------------------

  describe("GET /api/projects/:id/files/content", () => {
    test("returns file content from working tree", async () => {
      writeFileSync(join(repo.dir, "test.txt"), "hello world");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=test.txt`),
        state,
      );
      expect(res!.status).toBe(200);
      const content = await res!.text();
      expect(content).toBe("hello world");
    });

    test("returns 400 when path param is missing", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content`),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("path");
    });

    test("returns 400 for path traversal with ..", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=../../../etc/passwd`),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("traversal");
    });

    test("returns 400 for absolute path outside project", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=/etc/passwd`),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("traversal");
    });

    test("returns 404 for nonexistent file", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=nonexistent.txt`),
        state,
      );
      expect(res!.status).toBe(404);
    });

    test("reads file from git ref when ref is a different branch", async () => {
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/file-test"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await commitFile(repo.dir, "branch-file.txt", "branch content", "Add branch file");
      const proc2 = Bun.spawn(["git", "checkout", "main"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=branch-file.txt&ref=feature/file-test`),
        state,
      );
      expect(res!.status).toBe(200);
      const content = await res!.text();
      expect(content).toBe("branch content");
    });

    test("reads from working tree when ref matches current branch", async () => {
      await commitFile(repo.dir, "wt-file.txt", "committed", "Add file");
      writeFileSync(join(repo.dir, "wt-file.txt"), "uncommitted changes");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=wt-file.txt&ref=main`),
        state,
      );
      expect(res!.status).toBe(200);
      const content = await res!.text();
      expect(content).toBe("uncommitted changes");
    });

    test("reads nested file paths", async () => {
      mkdirSync(join(repo.dir, "subdir"), { recursive: true });
      writeFileSync(join(repo.dir, "subdir", "nested.txt"), "nested content");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=subdir/nested.txt`),
        state,
      );
      expect(res!.status).toBe(200);
      const content = await res!.text();
      expect(content).toBe("nested content");
    });

    test("serves working-tree image previews inline with uncorrupted bytes", async () => {
      const bytes = onePixelPng();
      mkdirSync(join(repo.dir, "assets"), { recursive: true });
      writeFileSync(join(repo.dir, "assets", "pixel.png"), bytes);

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=assets%2Fpixel.png`),
        state,
      );

      expect(res!.status).toBe(200);
      expect(res!.headers.get("Content-Type")).toBe("image/png");
      expect(res!.headers.get("Content-Disposition")).toBeNull();
      const body = new Uint8Array(await res!.arrayBuffer());
      expect([...body]).toEqual([...bytes]);
    });

    test("serves git-ref image previews inline with uncorrupted bytes", async () => {
      const bytes = onePixelPng();
      await git(repo.dir, ["checkout", "-b", "feature/image-preview"]);
      mkdirSync(join(repo.dir, "assets"), { recursive: true });
      writeFileSync(join(repo.dir, "assets", "pixel.png"), bytes);
      await git(repo.dir, ["add", "assets/pixel.png"]);
      await git(repo.dir, ["commit", "-m", "Add preview image"]);
      await git(repo.dir, ["checkout", "main"]);

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=assets%2Fpixel.png&ref=feature%2Fimage-preview`),
        state,
      );

      expect(res!.status).toBe(200);
      expect(res!.headers.get("Content-Type")).toBe("image/png");
      expect(res!.headers.get("Content-Disposition")).toBeNull();
      const body = new Uint8Array(await res!.arrayBuffer());
      expect([...body]).toEqual([...bytes]);
    });

    // ---- Download mode tests -----------------------------------------------

    test("download=1 sets Content-Disposition attachment header", async () => {
      writeFileSync(join(repo.dir, "report.csv"), "a,b,c");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=report.csv&download=1`),
        state,
      );
      expect(res!.status).toBe(200);
      const cd = res!.headers.get("Content-Disposition");
      expect(cd).toContain("attachment");
      expect(cd).toContain("report.csv");
    });

    test("download=1 returns binary content that preserves bytes", async () => {
      const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);
      writeFileSync(join(repo.dir, "data.bin"), bytes);

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=data.bin&download=1`),
        state,
      );
      expect(res!.status).toBe(200);
      const buf = new Uint8Array(await res!.arrayBuffer());
      expect(buf).toEqual(bytes);
    });

    test("download=1 sets content-based Content-Type", async () => {
      writeFileSync(join(repo.dir, "style.json"), "{}");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=style.json&download=1`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(res!.headers.get("Content-Type")).toContain("application/json");
    });

    test("non-download request does not set Content-Disposition", async () => {
      writeFileSync(join(repo.dir, "plain.txt"), "hello");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=plain.txt`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(res!.headers.get("Content-Disposition")).toBeNull();
    });

    test("download=1 from a git ref branch returns binary content", async () => {
      const bytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/dl-test"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc.exited;
      writeFileSync(join(repo.dir, "artifact.bin"), bytes);
      const proc2 = Bun.spawn(["git", "add", "."], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;
      const proc3 = Bun.spawn(["git", "commit", "-m", "Add artifact"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc3.exited;
      const proc4 = Bun.spawn(["git", "checkout", "main"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc4.exited;

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/content?path=artifact.bin&ref=feature/dl-test&download=1`),
        state,
      );
      expect(res!.status).toBe(200);
      const buf = new Uint8Array(await res!.arrayBuffer());
      expect(buf).toEqual(bytes);
      expect(res!.headers.get("Content-Disposition")).toContain("artifact.bin");
    });
  });

  // ---- GET /files/tree (directory listing) ---------------------------------

  describe("GET /api/projects/:id/files/tree", () => {
    test("returns entries for project root", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree?path=.`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.entries).toBeArray();
      // README.md is committed by the test repo helper
      const names = body.entries.map((e: any) => e.name);
      expect(names).toContain("README.md");
    });

    test("returns entries for a subdirectory", async () => {
      mkdirSync(join(repo.dir, "src"), { recursive: true });
      writeFileSync(join(repo.dir, "src/index.ts"), "console.log('hi')");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree?path=src`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      const names = body.entries.map((e: any) => e.name);
      expect(names).toContain("index.ts");
    });

    test("entries have correct type for files and directories", async () => {
      mkdirSync(join(repo.dir, "lib"), { recursive: true });
      writeFileSync(join(repo.dir, "lib/util.ts"), "export {}");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree?path=.`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      const libEntry = body.entries.find((e: any) => e.name === "lib");
      const readmeEntry = body.entries.find((e: any) => e.name === "README.md");
      expect(libEntry.type).toBe("directory");
      expect(readmeEntry.type).toBe("file");
    });

    test("entries only have name and type fields", async () => {
      writeFileSync(join(repo.dir, "hello.txt"), "hello world");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree?path=.`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      const fileEntry = body.entries.find((e: any) => e.name === "hello.txt");
      expect(Object.keys(fileEntry).toSorted()).toEqual(["name", "type"]);
    });

    test("directories sort before files", async () => {
      mkdirSync(join(repo.dir, "aaa-dir"), { recursive: true });
      writeFileSync(join(repo.dir, "aaa-file.txt"), "content");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree?path=.`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      const dirs = body.entries.filter((e: any) => e.type === "directory");
      const files = body.entries.filter((e: any) => e.type === "file");
      // All directories should come before all files
      const lastDirIndex = body.entries.lastIndexOf(dirs[dirs.length - 1]);
      const firstFileIndex = body.entries.indexOf(files[0]);
      expect(lastDirIndex).toBeLessThan(firstFileIndex);
    });

    test("returns 400 for path traversal with ..", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree?path=../../../etc`),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("traversal");
    });

    test("returns 400 for absolute path outside project", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree?path=/etc`),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("traversal");
    });

    test("returns 404 for nonexistent directory", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree?path=no-such-dir`),
        state,
      );
      expect(res!.status).toBe(404);
    });

    test("defaults to root when no path param given", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/files/tree`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      const names = body.entries.map((e: any) => e.name);
      expect(names).toContain("README.md");
    });
  });
});
