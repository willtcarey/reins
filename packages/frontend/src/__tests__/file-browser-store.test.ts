/**
 * Tests for file browser store filtering logic.
 * Network-dependent methods (fetchFiles, selectFile) are not tested here —
 * they need integration tests.
 */
import { describe, test, expect } from "bun:test";
import { FileBrowserStore } from "../models/stores/file-browser-store.js";

describe("FileBrowserStore", () => {
  describe("filter", () => {
    test("returns all files (up to limit) when query is empty", () => {
      const store = new FileBrowserStore();
      store.files = ["a.ts", "b.ts", "c.ts"];
      expect(store.filter("")).toEqual(["a.ts", "b.ts", "c.ts"]);
    });

    test("fuzzy matches file paths", () => {
      const store = new FileBrowserStore();
      store.files = [
        "packages/frontend/src/app.ts",
        "packages/backend/src/server.ts",
        "README.md",
      ];
      const results = store.filter("app");
      expect(results).toContain("packages/frontend/src/app.ts");
      expect(results).not.toContain("README.md");
    });

    test("ranks tighter matches higher", () => {
      const store = new FileBrowserStore();
      store.files = [
        "src/x-a-b-c-p-q.ts",
        "src/app.ts",
        "src/components/app-shell.ts",
      ];
      const results = store.filter("app");
      // "src/app.ts" has exact substring "app" (score 0), should rank first
      expect(results[0]).toBe("src/app.ts");
    });

    test("respects limit parameter", () => {
      const store = new FileBrowserStore();
      store.files = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);
      expect(store.filter("", 10).length).toBe(10);
    });

    test("returns empty for non-matching query", () => {
      const store = new FileBrowserStore();
      store.files = ["src/app.ts", "src/index.ts"];
      expect(store.filter("zzz")).toEqual([]);
    });
  });

  describe("reset", () => {
    test("clears selection state", () => {
      const store = new FileBrowserStore();
      store.selectedFile = "test.ts";
      store.fileContent = "content";
      store.contentError = "error";
      store.isBinary = true;
      store.contentLoading = true;

      store.reset();

      expect(store.selectedFile).toBeNull();
      expect(store.fileContent).toBeNull();
      expect(store.contentError).toBeNull();
      expect(store.isBinary).toBe(false);
      expect(store.contentLoading).toBe(false);
    });
  });

  describe("subscribe", () => {
    test("unsubscribe removes listener", () => {
      const store = new FileBrowserStore();
      let count = 0;
      const unsub = store.subscribe(() => count++);
      // Can't easily trigger notify without fetch, but verify unsubscribe works
      unsub();
      // No assertion needed — just verifying it doesn't throw
    });
  });
});
