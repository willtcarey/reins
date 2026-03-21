/**
 * Tests for HighlightController — reactive controller that owns syntax
 * highlighting for a single DiffHunk.
 *
 * Each diff-hunk creates its own HighlightController instance.
 * When `setHunk` receives a new hunk reference, text lines are sent to
 * the highlighter. The resulting HTML is stored on the controller (not
 * mutated onto DiffLine objects). Same-ref assignments are skipped.
 */
import { describe, test, expect } from "bun:test";
import { HighlightController } from "../controllers/highlight-controller.js";
import type { IHighlighter, HighlightHunkCallback } from "../models/changes/highlighter.js";
import type { DiffHunk, DiffLine } from "../models/changes/types.js";
import type { ReactiveController, ReactiveControllerHost } from "lit";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeHighlighter implements IHighlighter {
  hunkCalls: { path: string; lines: string[]; onComplete: HighlightHunkCallback }[] = [];
  disposed = false;

  highlightHunk(path: string, lines: string[], onComplete: HighlightHunkCallback): void {
    this.hunkCalls.push({ path, lines, onComplete });
    onComplete(lines.map((t) => `<span class="hl">${t}</span>`));
  }

  dispose(): void {
    this.disposed = true;
  }
}

class AsyncFakeHighlighter implements IHighlighter {
  pendingHunks: { path: string; lines: string[]; onComplete: HighlightHunkCallback }[] = [];
  disposed = false;

  highlightHunk(path: string, lines: string[], onComplete: HighlightHunkCallback): void {
    this.pendingHunks.push({ path, lines, onComplete });
  }

  completeHunk(index = this.pendingHunks.length - 1) {
    const req = this.pendingHunks[index];
    if (!req) return;
    req.onComplete(req.lines.map((t) => `<span class="hl">${t}</span>`));
  }

  dispose(): void {
    this.disposed = true;
  }
}

function fakeHost() {
  const controllers: ReactiveController[] = [];
  let updateCount = 0;
  return {
    addController(c: ReactiveController) { controllers.push(c); },
    removeController(c: ReactiveController) {
      const i = controllers.indexOf(c);
      if (i >= 0) controllers.splice(i, 1);
    },
    requestUpdate() { updateCount++; },
    updateComplete: Promise.resolve(true),
    get updateCount() { return updateCount; },
    get controllers() { return controllers; },
    disconnect() {
      for (const c of [...controllers]) c.hostDisconnected?.();
    },
    connect() {
      for (const c of [...controllers]) c.hostConnected?.();
    },
  } satisfies ReactiveControllerHost & {
    updateCount: number;
    controllers: ReactiveController[];
    disconnect(): void;
    connect(): void;
  };
}

function line(type: DiffLine["type"], text: string, oldLine?: number, newLine?: number): DiffLine {
  return { type, text, oldLine, newLine };
}

function makeHunk(header: string, lines: DiffLine[]): DiffHunk {
  return { header, lines };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HighlightController", () => {
  test("registers itself with the host", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);
    expect(host.controllers).toContain(ctrl);
  });

  test("setHunk triggers highlighting", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);

    expect(hl.hunkCalls.length).toBe(1);
    expect(hl.hunkCalls[0].path).toBe("a.ts");
    expect(hl.hunkCalls[0].lines).toEqual(["hello"]);
  });

  test("setHunk with null does not trigger highlighting", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.setHunk("a.ts", null);
    expect(hl.hunkCalls.length).toBe(0);
  });

  test("same hunk ref is skipped", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);
    ctrl.setHunk("a.ts", hunk); // same ref

    expect(hl.hunkCalls.length).toBe(1);
  });

  test("new hunk ref triggers highlighting", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk1 = makeHunk("@@", [line("add", "v1", 1, 1)]);
    ctrl.setHunk("a.ts", hunk1);

    const hunk2 = makeHunk("@@", [line("add", "v2", 1, 1)]);
    ctrl.setHunk("a.ts", hunk2);

    expect(hl.hunkCalls.length).toBe(2);
    expect(hl.hunkCalls[1].lines).toEqual(["v2"]);
  });

  test("host.requestUpdate called when highlighting completes", () => {
    const host = fakeHost();
    const hl = new AsyncFakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);

    expect(host.updateCount).toBe(0);
    hl.completeHunk(0);
    expect(host.updateCount).toBe(1);
  });

  test("getLineHtml returns highlighted HTML after completion", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);

    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">hello</span>');
  });

  test("getLineHtml returns undefined before completion", () => {
    const host = fakeHost();
    const hl = new AsyncFakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);

    expect(ctrl.getLineHtml(0)).toBeUndefined();

    hl.completeHunk(0);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">hello</span>');
  });

  test("getLineHtml returns undefined for out-of-range index", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);

    expect(ctrl.getLineHtml(99)).toBeUndefined();
  });

  test("new hunk clears stale HTML from previous hunk", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk1 = makeHunk("@@", [line("add", "v1", 1, 1)]);
    ctrl.setHunk("a.ts", hunk1);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">v1</span>');

    // Switch to async highlighter to control timing
    const hl2 = new AsyncFakeHighlighter();
    const ctrl2 = new HighlightController(fakeHost(), hl2);

    const hunkA = makeHunk("@@", [line("add", "old", 1, 1)]);
    ctrl2.setHunk("a.ts", hunkA);
    hl2.completeHunk(0);
    expect(ctrl2.getLineHtml(0)).toBe('<span class="hl">old</span>');

    // New hunk — html should be cleared immediately (before callback)
    const hunkB = makeHunk("@@", [line("add", "new", 1, 1)]);
    ctrl2.setHunk("a.ts", hunkB);
    expect(ctrl2.getLineHtml(0)).toBeUndefined();
  });

  test("stale callback does not set HTML for newer hunk", () => {
    const host = fakeHost();
    const hl = new AsyncFakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk1 = makeHunk("@@", [line("add", "v1", 1, 1)]);
    ctrl.setHunk("a.ts", hunk1);

    const hunk2 = makeHunk("@@", [line("add", "v2", 1, 1)]);
    ctrl.setHunk("a.ts", hunk2);

    // Complete the FIRST (stale) callback — should NOT set htmlLines
    hl.completeHunk(0);
    expect(ctrl.getLineHtml(0)).toBeUndefined();

    // Complete the second — should set htmlLines
    hl.completeHunk(1);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">v2</span>');
  });

  test("hostDisconnected is safe (does not dispose shared highlighter)", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    expect(() => host.disconnect()).not.toThrow();
    expect(hl.disposed).toBe(false);
  });

  test("hunk getter returns the last set hunk", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    expect(ctrl.hunk).toBeNull();

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);
    expect(ctrl.hunk).toBe(hunk);
  });

  test("setting null after a hunk clears the reference and html", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">hello</span>');

    ctrl.setHunk("a.ts", null);
    expect(ctrl.hunk).toBeNull();
    expect(ctrl.getLineHtml(0)).toBeUndefined();
    expect(hl.hunkCalls.length).toBe(1);
  });

  test("after expand, store produces new hunk — gets re-highlighted", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("context", "line1", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);

    expect(hl.hunkCalls.length).toBe(1);

    const hunkExpanded = { ...hunk };
    hunkExpanded.lines = [...hunk.lines, line("context", "line2", 2, 2)];
    ctrl.setHunk("a.ts", hunkExpanded);

    expect(hl.hunkCalls.length).toBe(2);
    expect(hl.hunkCalls[1].lines).toEqual(["line1", "line2"]);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">line1</span>');
    expect(ctrl.getLineHtml(1)).toBe('<span class="hl">line2</span>');
  });

  test("two controllers with same highlighter can highlight independently", () => {
    const hl = new FakeHighlighter();
    const host1 = fakeHost();
    const host2 = fakeHost();
    const ctrl1 = new HighlightController(host1, hl);
    const ctrl2 = new HighlightController(host2, hl);

    const hunk1 = makeHunk("@@", [line("add", "hello", 1, 1)]);
    const hunk2 = makeHunk("@@", [line("add", "world", 1, 1)]);

    ctrl1.setHunk("a.ts", hunk1);
    ctrl2.setHunk("b.ts", hunk2);

    expect(hl.hunkCalls.length).toBe(2);
    expect(host1.updateCount).toBe(1);
    expect(host2.updateCount).toBe(1);
    expect(ctrl1.getLineHtml(0)).toBe('<span class="hl">hello</span>');
    expect(ctrl2.getLineHtml(0)).toBe('<span class="hl">world</span>');
  });

  test("file path is passed through to the highlighter for language detection", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "x = 1", 1, 1)]);
    ctrl.setHunk("src/main.py", hunk);

    expect(hl.hunkCalls[0].path).toBe("src/main.py");
  });

  test("htmlLines getter returns the full array", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    expect(ctrl.htmlLines).toBeNull();

    const hunk = makeHunk("@@", [
      line("add", "a", 1, 1),
      line("add", "b", 2, 2),
    ]);
    ctrl.setHunk("a.ts", hunk);

    expect(ctrl.htmlLines).toEqual([
      '<span class="hl">a</span>',
      '<span class="hl">b</span>',
    ]);
  });
});
