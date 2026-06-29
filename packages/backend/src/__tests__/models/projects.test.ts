import { describe, test, expect, beforeEach, mock } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo, commitFile } from "../helpers/test-repo.js";
import { createProject } from "../../project-store.js";
import {
  ProjectModel,
  PathTraversalError,
  FileNotFoundError,
} from "../../models/projects.js";
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

describe("ProjectModel.serveFile", () => {
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test", repo.dir, "main");
    const broadcastSpy: Broadcast = mock<(msg: ServerMessage) => void>();
    const sessions = new Map<string, ManagedSession>();
    model = new ProjectModel(project.id, sessions, broadcastSpy);
  });

  // ---- MIME type detection -----------------------------------------------

  describe("MIME type detection", () => {
    test("detects text/plain for .txt files", async () => {
      writeFileSync(join(repo.dir, "readme.txt"), "hello");
      const result = await model.serveFile("readme.txt");
      expect(result.mimeType).toContain("text/plain");
    });

    test("detects text/* for .md files", async () => {
      writeFileSync(join(repo.dir, "doc.md"), "# Title\n\nSome content here.");
      const result = await model.serveFile("doc.md");
      // `file` examines content, not extension — markdown is detected as text/plain
      expect(result.mimeType).toStartWith("text/");
    });

    test("detects application/json for .json files", async () => {
      writeFileSync(join(repo.dir, "data.json"), '{"key": "value"}');
      const result = await model.serveFile("data.json");
      expect(result.mimeType).toContain("json");
    });

    test("detects image/png for .png files with valid content", async () => {
      // Write enough of a valid PNG for `file` to recognize it
      const pngData = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,  // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,  // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  // 1x1 pixel
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,  // 8-bit RGB
      ]);
      writeFileSync(join(repo.dir, "icon.png"), pngData);
      const result = await model.serveFile("icon.png");
      expect(result.mimeType).toBe("image/png");
    });

    test("detects text/* for source code files", async () => {
      writeFileSync(join(repo.dir, "app.rb"), "class App < Base; end");
      const result = await model.serveFile("app.rb");
      expect(result.mimeType).toStartWith("text/");
    });
  });

  // ---- Filename extraction -----------------------------------------------

  describe("filename extraction", () => {
    test("extracts filename from simple path", async () => {
      writeFileSync(join(repo.dir, "hello.txt"), "hi");
      const result = await model.serveFile("hello.txt");
      expect(result.filename).toBe("hello.txt");
    });

    test("extracts filename from nested path", async () => {
      mkdirSync(join(repo.dir, "a", "b"), { recursive: true });
      writeFileSync(join(repo.dir, "a", "b", "deep.md"), "deep");
      const result = await model.serveFile("a/b/deep.md");
      expect(result.filename).toBe("deep.md");
    });
  });

  // ---- Content bytes ------------------------------------------------------

  describe("content bytes", () => {
    test("returns bytes for text files", async () => {
      writeFileSync(join(repo.dir, "greet.txt"), "hello world");
      const result = await model.serveFile("greet.txt");
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(result.content)).toBe("hello world");
    });

    test("returns Uint8Array for binary files", async () => {
      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
      writeFileSync(join(repo.dir, "bin.dat"), bytes);
      const result = await model.serveFile("bin.dat");
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect([...result.content]).toEqual([...bytes]);
    });

    test("preserves binary bytes for a PNG file", async () => {
      const pngHeader = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      ]);
      writeFileSync(join(repo.dir, "image.png"), pngHeader);
      const result = await model.serveFile("image.png");
      expect([...result.content]).toEqual([...pngHeader]);
    });
  });

  // ---- Git ref path (non-checked-out branch) -----------------------------

  describe("git ref path", () => {
    test("reads text file from a different branch", async () => {
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/serve"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc.exited;
      await commitFile(repo.dir, "branch-only.txt", "on feature branch", "Add file");
      const proc2 = Bun.spawn(["git", "checkout", "main"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc2.exited;

      const result = await model.serveFile("branch-only.txt", "feature/serve");
      expect(new TextDecoder().decode(result.content)).toBe("on feature branch");
    });

    test("returns binary bytes from a different branch", async () => {
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/bin"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc.exited;
      writeFileSync(join(repo.dir, "data.bin"), bytes);
      const proc2 = Bun.spawn(["git", "add", "."], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;
      const proc3 = Bun.spawn(["git", "commit", "-m", "Add binary"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc3.exited;
      const proc4 = Bun.spawn(["git", "checkout", "main"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc4.exited;

      const result = await model.serveFile("data.bin", "feature/bin");
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect([...result.content]).toEqual([...bytes]);
      expect(result.filename).toBe("data.bin");
    });
  });

  // ---- Error cases -------------------------------------------------------

  describe("error cases", () => {
    test("throws PathTraversalError for traversal", async () => {
      expect(() => model.serveFile("../../../etc/passwd")).toThrow(PathTraversalError);
    });

    test("throws FileNotFoundError for missing file", async () => {
      expect(() => model.serveFile("nonexistent.txt")).toThrow(FileNotFoundError);
    });
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
