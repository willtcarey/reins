/**
 * Tests that in-place highlight mutations are visible to store subscribers.
 *
 * The Highlighter mutates DiffLine.html in place on the same object references,
 * then calls a callback which triggers store.notify(). This test uses a fake
 * highlighter to verify that:
 *   1. Subscribers are notified after highlighting completes.
 *   2. The mutated html values are visible on the original DiffLine objects.
 *
 * This is the store-level contract behind the renderVersion fix — without the
 * second notification, components holding stale object references would never
 * re-render the highlighted content.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { DiffStore } from "../stores/diff-store.js";
import type { DiffFile, DiffLine } from "../changes/types.js";
import type { IHighlighter } from "../changes/highlighter.js";
import type { HighlightCallback } from "../changes/highlighter.js";

// ---------------------------------------------------------------------------
// Fake highlighter that simulates in-place mutation
// ---------------------------------------------------------------------------

class FakeHighlighter implements IHighlighter {
  /** Captured calls for assertions. */
  calls: { files: DiffFile[]; onComplete: HighlightCallback }[] = [];

  highlight(files: DiffFile[], onComplete: HighlightCallback): void {
    this.calls.push({ files, onComplete });
    // Simulate what the real Shiki worker does: mutate line.html in place
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          line.html = `<span class="hl">${line.text}</span>`;
        }
      }
    }
    // Call back synchronously (real worker is async, but the contract is the same)
    onComplete();
  }

  dispose(): void {}
}

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

describe("in-place highlight mutation", () => {
  let highlighter: FakeHighlighter;
  let store: DiffStore;

  beforeEach(() => {
    highlighter = new FakeHighlighter();
    store = new DiffStore(highlighter);
    mockFetchNoop();
  });

  afterEach(() => {
    store.dispose();
    globalThis.fetch = originalFetch;
  });

  test("expandHunk triggers highlighter and subscribers see mutated html", async () => {
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

    await store.expandHunk("src/foo.ts", 0, "down", 2);

    // Highlighter was called
    expect(highlighter.calls.length).toBe(1);

    // Subscriber was notified (once for the line insertion + once for highlight callback)
    expect(notifyCount).toBeGreaterThanOrEqual(2);

    // The original DiffLine objects have html set in place
    const hunk = store.fullData!.files[0].hunks[0];
    for (const l of hunk.lines) {
      expect(l.html).toBe(`<span class="hl">${l.text}</span>`);
    }
  });

  test("lines without html before highlighting get html after", async () => {
    store.setProject(1);
    const originalLine = line("context", "hello world", 5, 5);
    expect(originalLine.html).toBeUndefined();

    store.fullData = {
      files: [
        makeFile("a.ts", [{
          header: "@@ -5,1 +5,1 @@",
          lines: [originalLine],
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

    // The original line object (same reference) now has html set
    expect(originalLine.html).toBe('<span class="hl">hello world</span>');

    // The newly inserted line also has html
    const newLine = store.fullData!.files[0].hunks[0].lines[1];
    expect(newLine.html).toBe(`<span class="hl">${newLine.text}</span>`);
  });

  test("highlight callback fires a second notify so components re-render", async () => {
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

    // Collect the sequence of notification states — specifically whether
    // html is set on the lines at each notification
    const htmlStates: (string | undefined)[] = [];
    store.subscribe(() => {
      const lines = store.fullData?.files[0]?.hunks[0]?.lines;
      if (lines && lines.length > 0) {
        htmlStates.push(lines[0].html);
      }
    });

    await store.expandHunk("b.ts", 0, "down", 1);

    // There should be at least 2 notifications:
    // 1st: line insertion (html may not be set yet depending on timing)
    // 2nd: highlight callback (html IS set)
    expect(htmlStates.length).toBeGreaterThanOrEqual(2);

    // The last notification should have html set
    const lastState = htmlStates[htmlStates.length - 1];
    expect(lastState).toContain("<span");
  });
});
