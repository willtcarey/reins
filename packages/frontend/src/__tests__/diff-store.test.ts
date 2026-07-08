/**
 * Tests for DiffStore — synchronous state management and expandHunk logic.
 *
 * Network polling and full-diff fetching are not exercised here; we focus on
 * the store's reactive state, mode/branch setters, and the per-hunk expansion
 * algorithm.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DiffStore } from "../models/stores/diff-store.js";
import type { DiffFile, DiffHunk, DiffLine } from "../models/changes/types.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers (same pattern as project-store.test.ts)
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/** Swallow all fetches with empty-OK responses (for setProject polling). */
function mockFetchNoop() {
  mockFetch((url) => {
    if (url.includes("/diff/files")) return jsonResponse({ files: [] });
    if (url.includes("/git/spread")) return jsonResponse({ branch: "", aheadBase: 0, behindBase: 0, aheadRemote: null, behindRemote: null });
    return jsonResponse({});
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a simple DiffLine. */
function line(
  type: DiffLine["type"],
  text: string,
  oldLine?: number,
  newLine?: number,
): DiffLine {
  return { type, text, oldLine, newLine };
}

/** Build a minimal DiffFile with hunks for expansion tests. */
function makeFile(path: string, hunks: DiffHunk[]): DiffFile {
  return { path, additions: 0, removals: 0, hunks };
}

/**
 * Build file content string from an array of line texts (will be split by
 * newline on the fetch side). The returned text, when split, becomes 1-indexed
 * after the store prepends "".
 */
function fileContent(lines: string[]): string {
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiffStore", () => {
  let store: DiffStore;

  beforeEach(() => {
    store = new DiffStore();
    // Prevent real fetches; tests that need fetch will override.
    mockFetchNoop();
  });

  afterEach(() => {
    store.dispose();
    restoreFetch();
  });

  // ---- Initial state -------------------------------------------------------

  describe("initial state", () => {
    test("projectId is null", () => {
      expect(store.projectId).toBeNull();
    });

    test("fileData is empty", () => {
      expect(store.fileData.data).toEqual({ files: [], branch: null, baseBranch: null });
    });

    test("fullData is null", () => {
      expect(store.fullData.data).toBeNull();
    });

    test("diffMode defaults to branch", () => {
      expect(store.diffMode).toBe("branch");
    });

    test("contextLines defaults to 3", () => {
      expect(store.contextLines).toBe(3);
    });

    test("spread is null", () => {
      expect(store.spread).toBeNull();
    });
  });

  // ---- Subscribe / notify ---------------------------------------------------

  describe("subscribe / notify", () => {
    test("subscribe returns unsubscribe function", () => {
      const unsub = store.subscribe(() => {});
      expect(typeof unsub).toBe("function");
    });

    test("listeners are called on state changes", async () => {
      let count = 0;
      store.subscribe(() => { count++; });

      // setProject triggers notify
      store.setProject(1);
      // Let polling tick complete
      await new Promise((r) => setTimeout(r, 50));

      expect(count).toBeGreaterThan(0);
    });

    test("unsubscribe stops notifications", async () => {
      let count = 0;
      const unsub = store.subscribe(() => { count++; });
      store.setProject(1);
      await new Promise((r) => setTimeout(r, 50));
      const countBefore = count;

      unsub();
      store.setProject(2);
      await new Promise((r) => setTimeout(r, 50));

      expect(count).toBe(countBefore);
    });
  });

  // ---- setProject -----------------------------------------------------------

  describe("setProject", () => {
    test("sets projectId", () => {
      store.setProject(5);
      expect(store.projectId).toBe(5);
    });

    test("resets all state", () => {
      // Pre-populate some state
      store.fullData = store.fullData.asLoaded({ files: [], branch: "x", baseBranch: "main" });
      store.spread = { branch: "x", aheadBase: 1, behindBase: 0, aheadRemote: null, behindRemote: null };
      store.fileData = store.fileData.asError("stale error");

      store.setProject(1);

      expect(store.fileData.data).toEqual({ files: [], branch: null, baseBranch: null });
      expect(store.fileData.error).toBeNull();
      expect(store.fullData.data).toBeNull();
      expect(store.spread).toBeNull();
      expect(store.contextLines).toBe(3);
    });

    test("same projectId is a no-op", () => {
      store.setProject(3);
      let notified = false;
      store.subscribe(() => { notified = true; });
      store.setProject(3);
      expect(notified).toBe(false);
    });
  });

  // ---- setBranch ------------------------------------------------------------

  describe("setBranch", () => {
    test("clears fullData", () => {
      store.setProject(1);
      store.fullData = store.fullData.asLoaded({ files: [], branch: "a", baseBranch: "main" });
      store.setBranch("feat/new");
      expect(store.fullData.data).toBeNull();
    });

    test("notifies listeners", () => {
      store.setProject(1);
      let notified = false;
      store.subscribe(() => { notified = true; });
      store.setBranch("feat/x");
      expect(notified).toBe(true);
    });

    test("same branch is a no-op", () => {
      store.setProject(1);
      store.setBranch("feat/a");
      let notified = false;
      store.subscribe(() => { notified = true; });
      store.setBranch("feat/a");
      expect(notified).toBe(false);
    });
  });

  // ---- setDiffMode ----------------------------------------------------------

  describe("setDiffMode", () => {
    test("changes diffMode", async () => {
      store.setProject(1);
      await store.setDiffMode("uncommitted");
      expect(store.diffMode).toBe("uncommitted");
    });

    test("clears fullData before re-fetch", async () => {
      store.setProject(1);
      store.fullData = store.fullData.asLoaded({ files: [], branch: "x", baseBranch: "main" });

      // Track whether fullData was nulled during the mode change
      let wasNulled = false;
      store.subscribe(() => {
        if (store.fullData.data === null) wasNulled = true;
      });

      await store.setDiffMode("uncommitted");
      expect(wasNulled).toBe(true);
    });

    test("same mode is a no-op", async () => {
      store.setProject(1);
      let notified = false;
      store.subscribe(() => { notified = true; });
      await store.setDiffMode("branch"); // default is already "branch"
      expect(notified).toBe(false);
    });
  });

  // ---- clearFullDiff --------------------------------------------------------

  describe("clearFullDiff", () => {
    test("sets fullData to null", () => {
      store.fullData = store.fullData.asLoaded({ files: [], branch: null, baseBranch: null });
      store.clearFullDiff();
      expect(store.fullData.data).toBeNull();
    });

    test("resets contextLines to default (3)", () => {
      store.contextLines = 10;
      store.clearFullDiff();
      expect(store.contextLines).toBe(3);
    });

    test("notifies listeners", () => {
      let notified = false;
      store.subscribe(() => { notified = true; });
      store.clearFullDiff();
      expect(notified).toBe(true);
    });
  });

  // ---- Patch diff -----------------------------------------------------------

  describe("fetchPatchDiff", () => {
    const patch = `diff --git a/demo.txt b/demo.txt
index 1111111..2222222 100644
--- a/demo.txt
+++ b/demo.txt
@@ -1 +1 @@
-old
+new
`;

    test("fetches the streaming diff with existing diff params and stores raw patch data", async () => {
      const requests: string[] = [];
      mockFetch((url) => {
        requests.push(url);
        if (url.includes("/diff/files")) {
          return jsonResponse({ files: [], branch: "feature/raw", baseBranch: "main" });
        }
        if (url.includes("/git/spread")) return jsonResponse({});
        if (url.includes("/diff/patch")) return textResponse(patch);
        return jsonResponse({}, false);
      });

      store.setProject(7);
      store.setBranch("feature/raw");
      store.fullData = store.fullData.asLoaded({ files: [], branch: "classic", baseBranch: "main" });

      await store.fetchPatchDiff();

      expect(requests).toContain("/api/projects/7/diff/patch?context=3&mode=branch&branch=feature%2Fraw");
      expect(store.patchData.data?.patch).toBe(patch);
      expect(store.patchData.data?.version).toBe(1);
      expect(store.patchData.data?.cacheKeyPrefix).toBe("project-7-branch-3-feature/raw-v1");
      expect(store.patchData.data?.branch).toBe("feature/raw");
      expect(store.patchData.data?.baseBranch).toBe("main");
      expect(store.fullData.data?.branch).toBe("classic");
      expect(store.patchData.error).toBeNull();
    });

    test("clearPatchDiff discards only patch renderer state", () => {
      store.patchData = store.patchData.asLoaded({ patch: "", cacheKeyPrefix: "test", version: 1, branch: null, baseBranch: null });
      store.fullData = store.fullData.asLoaded({ files: [], branch: "classic", baseBranch: "main" });

      store.clearPatchDiff();

      expect(store.patchData.data).toBeNull();
      expect(store.fullData.data?.branch).toBe("classic");
    });

    test("increments patch versions and cache key prefixes on each successful fetch", async () => {
      const patches = [
        patch,
        `diff --git a/demo.txt b/demo.txt
index 1111111..3333333 100644
--- a/demo.txt
+++ b/demo.txt
@@ -1 +1 @@
-old
+newer
`,
      ];
      mockFetch((url) => {
        if (url.includes("/diff/patch")) return textResponse(patches.shift() ?? patch);
        if (url.includes("/diff/files")) return jsonResponse({ files: [] });
        if (url.includes("/git/spread")) return jsonResponse({});
        return jsonResponse({});
      });
      store.setProject(1);

      await store.fetchPatchDiff();
      const first = store.patchData.data!;
      await store.fetchPatchDiff();
      const second = store.patchData.data!;

      expect(first.patch).toBe(patch);
      expect(second.patch).toContain("newer");
      expect(first.version).toBe(1);
      expect(second.version).toBe(2);
      expect(second.cacheKeyPrefix).not.toBe(first.cacheKeyPrefix);
    });

    test("refresh refetches a loaded CodeView patch diff when file summaries are unchanged", async () => {
      const patches = [
        patch,
        `diff --git a/demo.txt b/demo.txt
index 1111111..3333333 100644
--- a/demo.txt
+++ b/demo.txt
@@ -1 +1 @@
-old
+newer
`,
      ];
      mockFetch((url) => {
        if (url.includes("/diff/patch")) return textResponse(patches.shift() ?? patch);
        if (url.includes("/diff/files")) {
          return jsonResponse({
            files: [{ path: "demo.txt", additions: 1, removals: 1 }],
            branch: "feature/raw",
            baseBranch: "main",
          });
        }
        if (url.includes("/git/spread")) return jsonResponse({});
        return jsonResponse({});
      });
      store.setProject(1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      await store.fetchPatchDiff();
      const first = store.patchData.data!;
      await store.refresh();
      const second = store.patchData.data!;

      expect(first.patch).toBe(patch);
      expect(second.patch).toContain("newer");
      expect(second.version).toBe(first.version + 1);
    });

    test("refresh with onlyFetchDiffIfNeeded updates file summaries without refetching unchanged loaded patch data", async () => {
      const patches = [
        patch,
        `diff --git a/demo.txt b/demo.txt
index 1111111..3333333 100644
--- a/demo.txt
+++ b/demo.txt
@@ -1 +1 @@
-old
+newer
`,
      ];
      mockFetch((url) => {
        if (url.includes("/diff/patch")) return textResponse(patches.shift() ?? patch);
        if (url.includes("/diff/files")) {
          return jsonResponse({
            files: [{ path: "demo.txt", additions: 1, removals: 1 }],
            branch: "feature/raw",
            baseBranch: "main",
          });
        }
        if (url.includes("/git/spread")) return jsonResponse({});
        return jsonResponse({});
      });
      store.setProject(1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      await store.fetchPatchDiff();
      const first = store.patchData.data!;
      await store.refresh({ onlyFetchDiffIfNeeded: true });
      const second = store.patchData.data!;

      expect(first.patch).toBe(patch);
      expect(second).toBe(first);
      expect(patches.length).toBe(1);
    });
  });

  // ---- expandHunk -----------------------------------------------------------

  describe("expandHunk", () => {
    // 10-line file: lines 1..10
    const FILE_PATH = "src/foo.ts";
    const FILE_LINES = [
      "line1", "line2", "line3", "line4", "line5",
      "line6", "line7", "line8", "line9", "line10",
    ];

    function setupFileAndStore(hunks: DiffHunk[]) {
      store.setProject(1);
      store.fullData = store.fullData.asLoaded({
        files: [makeFile(FILE_PATH, hunks)],
        branch: "feat",
        baseBranch: "main",
      });

      // Mock fetch for file content request
      mockFetch((url) => {
        if (url.includes("/files/content?")) return textResponse(fileContent(FILE_LINES));
        if (url.includes("/diff/files")) return jsonResponse({ files: [] });
        if (url.includes("/git/spread")) return jsonResponse({});
        return jsonResponse({});
      });
    }

    test("returns 0 when no fullData", async () => {
      store.setProject(1);
      const count = await store.expandHunk("anything.ts", 0, "down");
      expect(count).toBe(0);
    });

    test("returns 0 for invalid hunkIndex (negative)", async () => {
      setupFileAndStore([{
        header: "@@ -5,3 +5,3 @@",
        lines: [
          line("context", "line5", 5, 5),
          line("add", "new6", undefined, 6),
          line("remove", "line6", 6, undefined),
        ],
      }]);
      const count = await store.expandHunk(FILE_PATH, -1, "down");
      expect(count).toBe(0);
    });

    test("returns 0 for invalid hunkIndex (too large)", async () => {
      setupFileAndStore([{
        header: "@@ -5,3 +5,3 @@",
        lines: [line("context", "line5", 5, 5)],
      }]);
      const count = await store.expandHunk(FILE_PATH, 99, "down");
      expect(count).toBe(0);
    });

    test("returns 0 for unknown file path", async () => {
      setupFileAndStore([{
        header: "@@ -5,1 +5,1 @@",
        lines: [line("context", "line5", 5, 5)],
      }]);
      const count = await store.expandHunk("nonexistent.ts", 0, "down");
      expect(count).toBe(0);
    });

    test("expand down appends context lines", async () => {
      // Hunk covers line 3..5, file has 10 lines
      setupFileAndStore([{
        header: "@@ -3,3 +3,3 @@",
        lines: [
          line("context", "line3", 3, 3),
          line("context", "line4", 4, 4),
          line("context", "line5", 5, 5),
        ],
      }]);

      const count = await store.expandHunk(FILE_PATH, 0, "down", 3);
      expect(count).toBe(3);

      const hunk = store.fullData.data!.files[0].hunks[0];
      // Original 3 + 3 appended = 6
      expect(hunk.lines.length).toBe(6);
      // Appended lines are 6, 7, 8
      expect(hunk.lines[3].newLine).toBe(6);
      expect(hunk.lines[4].newLine).toBe(7);
      expect(hunk.lines[5].newLine).toBe(8);
      expect(hunk.lines[3].type).toBe("context");
    });

    test("expand up prepends context lines", async () => {
      // Hunk covers lines 5..7
      setupFileAndStore([{
        header: "@@ -5,3 +5,3 @@",
        lines: [
          line("context", "line5", 5, 5),
          line("context", "line6", 6, 6),
          line("context", "line7", 7, 7),
        ],
      }]);

      const count = await store.expandHunk(FILE_PATH, 0, "up", 3);
      expect(count).toBe(3);

      const hunk = store.fullData.data!.files[0].hunks[0];
      expect(hunk.lines.length).toBe(6);
      // Prepended lines are 2, 3, 4
      expect(hunk.lines[0].newLine).toBe(2);
      expect(hunk.lines[1].newLine).toBe(3);
      expect(hunk.lines[2].newLine).toBe(4);
    });

    test("expand up respects file start boundary", async () => {
      // Hunk starts at line 2 — only 1 line above it
      setupFileAndStore([{
        header: "@@ -2,2 +2,2 @@",
        lines: [
          line("context", "line2", 2, 2),
          line("context", "line3", 3, 3),
        ],
      }]);

      const count = await store.expandHunk(FILE_PATH, 0, "up", 10);
      expect(count).toBe(1);

      const hunk = store.fullData.data!.files[0].hunks[0];
      expect(hunk.lines.length).toBe(3);
      expect(hunk.lines[0].newLine).toBe(1);
      expect(hunk.lines[0].text).toBe("line1");
    });

    test("expand down respects file end boundary", async () => {
      // Hunk covers lines 8..10 (last 3 lines of 10-line file)
      setupFileAndStore([{
        header: "@@ -8,3 +8,3 @@",
        lines: [
          line("context", "line8", 8, 8),
          line("context", "line9", 9, 9),
          line("context", "line10", 10, 10),
        ],
      }]);

      const count = await store.expandHunk(FILE_PATH, 0, "down", 10);
      expect(count).toBe(0);
    });

    test("expand notifies listeners", async () => {
      setupFileAndStore([{
        header: "@@ -3,2 +3,2 @@",
        lines: [
          line("context", "line3", 3, 3),
          line("context", "line4", 4, 4),
        ],
      }]);

      let count = 0;
      store.subscribe(() => { count++; });

      await store.expandHunk(FILE_PATH, 0, "down", 2);
      expect(count).toBeGreaterThan(0);
    });

    test("hunk merge when gap is closed (expand down)", async () => {
      // Two hunks: hunk0 covers 3..4, hunk1 covers 6..7
      // Gap is line 5. Expanding hunk0 down by ≥1 should merge them.
      setupFileAndStore([
        {
          header: "@@ -3,2 +3,2 @@",
          lines: [
            line("context", "line3", 3, 3),
            line("context", "line4", 4, 4),
          ],
        },
        {
          header: "@@ -6,2 +6,2 @@",
          lines: [
            line("context", "line6", 6, 6),
            line("context", "line7", 7, 7),
          ],
        },
      ]);

      const inserted = await store.expandHunk(FILE_PATH, 0, "down", 15);
      expect(inserted).toBe(1); // only 1 line in the gap (line 5)

      const file = store.fullData.data!.files[0];
      // After merge, should be a single hunk
      expect(file.hunks.length).toBe(1);
      // Combined: lines 3,4 + [5 inserted] + 6,7
      expect(file.hunks[0].lines.length).toBe(5);
    });

    test("hunk merge when gap is closed (expand up)", async () => {
      // Two hunks: hunk0 covers 3..4, hunk1 covers 6..7
      // Expanding hunk1 up should close the gap and merge.
      setupFileAndStore([
        {
          header: "@@ -3,2 +3,2 @@",
          lines: [
            line("context", "line3", 3, 3),
            line("context", "line4", 4, 4),
          ],
        },
        {
          header: "@@ -6,2 +6,2 @@",
          lines: [
            line("context", "line6", 6, 6),
            line("context", "line7", 7, 7),
          ],
        },
      ]);

      const inserted = await store.expandHunk(FILE_PATH, 1, "up", 15);
      expect(inserted).toBe(1);

      const file = store.fullData.data!.files[0];
      expect(file.hunks.length).toBe(1);
      expect(file.hunks[0].lines.length).toBe(5);
    });

    test("hunk merge produces new hunk ref (expand down)", async () => {
      // After merge, the surviving hunk must be a new object reference
      // so HighlightController detects the change via ref-equality.
      setupFileAndStore([
        {
          header: "@@ -3,2 +3,2 @@",
          lines: [
            line("context", "line3", 3, 3),
            line("context", "line4", 4, 4),
          ],
        },
        {
          header: "@@ -6,2 +6,2 @@",
          lines: [
            line("context", "line6", 6, 6),
            line("context", "line7", 7, 7),
          ],
        },
      ]);

      const hunk0Before = store.fullData.data!.files[0].hunks[0];
      await store.expandHunk(FILE_PATH, 0, "down", 15);

      const file = store.fullData.data!.files[0];
      expect(file.hunks.length).toBe(1);
      expect(file.hunks[0]).not.toBe(hunk0Before);
      expect(file.hunks[0].lines.map(l => l.newLine)).toEqual([3, 4, 5, 6, 7]);
    });

    test("hunk merge produces new hunk ref (expand up)", async () => {
      // When expanding hunk1 up, the merge puts all lines into hunk0
      // (the earlier hunk). hunk0 must get a new ref, not be mutated in-place.
      setupFileAndStore([
        {
          header: "@@ -3,2 +3,2 @@",
          lines: [
            line("context", "line3", 3, 3),
            line("context", "line4", 4, 4),
          ],
        },
        {
          header: "@@ -6,2 +6,2 @@",
          lines: [
            line("context", "line6", 6, 6),
            line("context", "line7", 7, 7),
          ],
        },
      ]);

      const hunk0Before = store.fullData.data!.files[0].hunks[0];
      await store.expandHunk(FILE_PATH, 1, "up", 15);

      const file = store.fullData.data!.files[0];
      expect(file.hunks.length).toBe(1);
      expect(file.hunks[0]).not.toBe(hunk0Before);
      expect(file.hunks[0].lines.map(l => l.newLine)).toEqual([3, 4, 5, 6, 7]);
    });

    test("expand with add/remove lines finds correct anchor", async () => {
      // Hunk with mixed line types — oldLine and newLine are on different lines
      setupFileAndStore([{
        header: "@@ -4,3 +4,3 @@",
        lines: [
          line("context", "line4", 4, 4),
          line("remove", "old5", 5, undefined),
          line("add", "new5", undefined, 5),
          line("context", "line6", 6, 6),
        ],
      }]);

      const count = await store.expandHunk(FILE_PATH, 0, "down", 2);
      expect(count).toBe(2);

      const hunk = store.fullData.data!.files[0].hunks[0];
      expect(hunk.lines.length).toBe(6);
      expect(hunk.lines[4].newLine).toBe(7);
      expect(hunk.lines[5].newLine).toBe(8);
    });
  });

  // ---- dispose --------------------------------------------------------------

  describe("dispose", () => {
    test("clears listeners", () => {
      let count = 0;
      store.subscribe(() => { count++; });
      store.dispose();
      // After dispose, setProject should not notify
      store.setProject(99);
      expect(count).toBe(0);
    });

    test("does not throw on double dispose", () => {
      store.dispose();
      expect(() => store.dispose()).not.toThrow();
    });
  });
});
