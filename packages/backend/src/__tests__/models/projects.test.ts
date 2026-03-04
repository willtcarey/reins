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
import type { Broadcast } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";

describe("ProjectModel.serveFile", () => {
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test", repo.dir, "main");
    const broadcastSpy = mock() as unknown as Broadcast;
    const sessions = new Map<string, ManagedSession>();
    model = new ProjectModel(project.id, repo.dir, "main", sessions, broadcastSpy);
  });

  // ---- MIME type detection -----------------------------------------------

  describe("MIME type detection", () => {
    test("detects text/plain for .txt files", async () => {
      writeFileSync(join(repo.dir, "readme.txt"), "hello");
      const result = await model.serveFile("readme.txt");
      expect(result.mimeType).toContain("text/plain");
    });

    test("detects text/markdown for .md files", async () => {
      writeFileSync(join(repo.dir, "doc.md"), "# Title");
      const result = await model.serveFile("doc.md");
      expect(result.mimeType).toContain("text/markdown");
    });

    test("detects application/json for .json files", async () => {
      writeFileSync(join(repo.dir, "data.json"), "{}");
      const result = await model.serveFile("data.json");
      expect(result.mimeType).toContain("application/json");
    });

    test("detects image/png for .png files", async () => {
      // Write a minimal PNG header
      const pngHeader = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      writeFileSync(join(repo.dir, "icon.png"), pngHeader);
      const result = await model.serveFile("icon.png");
      expect(result.mimeType).toContain("image/png");
    });

    test("detects spreadsheet MIME for .xlsx files", async () => {
      // Write minimal bytes so Bun can detect from extension
      writeFileSync(join(repo.dir, "report.xlsx"), "fake xlsx");
      const result = await model.serveFile("report.xlsx");
      expect(result.mimeType).toContain("spreadsheet");
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

  // ---- Content: text (non-download) --------------------------------------

  describe("text content (non-download)", () => {
    test("returns string content for text file", async () => {
      writeFileSync(join(repo.dir, "greet.txt"), "hello world");
      const result = await model.serveFile("greet.txt");
      expect(typeof result.content).toBe("string");
      expect(result.content).toBe("hello world");
    });
  });

  // ---- Content: binary (download) ----------------------------------------

  describe("binary content (download)", () => {
    test("returns Uint8Array when download is true", async () => {
      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
      writeFileSync(join(repo.dir, "bin.dat"), bytes);
      const result = await model.serveFile("bin.dat", null, true);
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect(new Uint8Array(result.content as Uint8Array)).toEqual(bytes);
    });

    test("preserves binary bytes for a PNG file download", async () => {
      const pngHeader = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      ]);
      writeFileSync(join(repo.dir, "image.png"), pngHeader);
      const result = await model.serveFile("image.png", null, true);
      expect(new Uint8Array(result.content as Uint8Array)).toEqual(pngHeader);
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
      expect(typeof result.content).toBe("string");
      expect(result.content).toBe("on feature branch");
    });

    test("downloads binary file from a different branch via showFileBinary", async () => {
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

      const result = await model.serveFile("data.bin", "feature/bin", true);
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect(new Uint8Array(result.content as Uint8Array)).toEqual(bytes);
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
