/**
 * Tests for DiffStore's expand-hunk behavior after highlighting was moved
 * to HighlightController.
 *
 * The store now just inserts context lines and notifies — no highlighting.
 * These tests verify that:
 *   1. expandHunk inserts new lines into the hunk.
 *   2. Subscribers are notified after line insertion.
 *   3. New lines don't have html set (highlighting is the controller's job).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { DiffStore } from "../stores/diff-store.js";
import type { DiffFile, DiffLine } from "../changes/types.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url));
  }) as any;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/plain" } });
}

function mockFetchNoop() {
  mockFetch((url) => {
    if (url.includes("/diff/files")) return jsonResponse({ files: [] });
    if (url.includes("/git/spread")) return jsonResponse({ branch: "", aheadBase: 0, behindBase: 0, aheadRemote: null, behindRemote: null });
    return jsonResponse({});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(type: DiffLine["type"], text: string, oldLine?: number, newLine?: number): DiffLine {
  return { type, text, oldLine, newLine };
}

function makeFile(path: string, hunks: { header: string; lines: DiffLine[] }[]): DiffFile {
  return { path, additions: 0, removals: 0, hunks };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiffStore expandHunk (no highlighting)", () => {
  let store: DiffStore;

  beforeEach(() => {
    store = new DiffStore();
    mockFetchNoop();
  });

  afterEach(() => {
    store.dispose();
    globalThis.fetch = originalFetch;
  });

  test("expandHunk inserts lines and notifies subscribers", async () => {
    store.setProject(1);
    store.fullData = {
      files: [
        makeFile("src/foo.ts", [
          {
            header: "@@ -3,2 +3,2 @@",
            lines: [
              line("context", "line3", 3, 3),
              line("context", "line4", 4, 4),
            ],
          },
        ]),
      ],
      branch: "feat",
      baseBranch: "main",
    };

    // Mock fetch for file content
    mockFetch((url) => {
      if (url.includes("/file?")) return textResponse("line1\nline2\nline3\nline4\nline5\nline6");
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      if (url.includes("/git/spread")) return jsonResponse({});
      return jsonResponse({});
    });

    // Track notifications
    let notifyCount = 0;
    store.subscribe(() => { notifyCount++; });

    const inserted = await store.expandHunk("src/foo.ts", 0, "down", 2);

    // Lines were inserted
    expect(inserted).toBe(2);
    const hunk = store.fullData!.files[0].hunks[0];
    expect(hunk.lines.length).toBe(4); // 2 original + 2 new

    // Subscriber was notified at least once for line insertion
    expect(notifyCount).toBeGreaterThanOrEqual(1);
  });

  test("newly inserted lines have no html (highlighting is the controller's job)", async () => {
    store.setProject(1);
    store.fullData = {
      files: [
        makeFile("a.ts", [{
          header: "@@ -5,1 +5,1 @@",
          lines: [line("context", "hello world", 5, 5)],
        }]),
      ],
      branch: "feat",
      baseBranch: "main",
    };

    mockFetch((url) => {
      if (url.includes("/file?")) return textResponse("l1\nl2\nl3\nl4\nhello world\nl6");
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      if (url.includes("/git/spread")) return jsonResponse({});
      return jsonResponse({});
    });

    await store.expandHunk("a.ts", 0, "down", 1);

    // The newly inserted line should NOT have html — that's the controller's job
    const newLine = store.fullData!.files[0].hunks[0].lines[1];
    expect(newLine.html).toBeUndefined();
    expect(newLine.text).toBe("l6");
  });

  test("expandHunk produces a new file object reference for the mutated file", async () => {
    store.setProject(1);
    const originalFile = makeFile("src/foo.ts", [
      {
        header: "@@ -3,2 +3,2 @@",
        lines: [
          line("context", "line3", 3, 3),
          line("context", "line4", 4, 4),
        ],
      },
    ]);
    store.fullData = {
      files: [originalFile],
      branch: "feat",
      baseBranch: "main",
    };

    mockFetch((url) => {
      if (url.includes("/file?")) return textResponse("line1\nline2\nline3\nline4\nline5\nline6");
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      if (url.includes("/git/spread")) return jsonResponse({});
      return jsonResponse({});
    });

    await store.expandHunk("src/foo.ts", 0, "down", 2);

    // The file in fullData should be a different object from the original
    const updatedFile = store.fullData!.files[0];
    expect(updatedFile).not.toBe(originalFile);
    // But should still have the same path and expanded content
    expect(updatedFile.path).toBe("src/foo.ts");
    expect(updatedFile.hunks[0].lines.length).toBe(4);
  });

  test("subscribers are notified so the highlight controller can react", async () => {
    store.setProject(1);
    store.fullData = {
      files: [
        makeFile("b.ts", [{
          header: "@@ -2,1 +2,1 @@",
          lines: [line("context", "line2", 2, 2)],
        }]),
      ],
      branch: "feat",
      baseBranch: "main",
    };

    mockFetch((url) => {
      if (url.includes("/file?")) return textResponse("line1\nline2\nline3");
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      if (url.includes("/git/spread")) return jsonResponse({});
      return jsonResponse({});
    });

    const notifications: number[] = [];
    store.subscribe(() => {
      const lines = store.fullData?.files[0]?.hunks[0]?.lines;
      notifications.push(lines?.length ?? 0);
    });

    await store.expandHunk("b.ts", 0, "down", 1);

    // At least one notification with the expanded line count
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications).toContain(2); // 1 original + 1 new
  });
});
