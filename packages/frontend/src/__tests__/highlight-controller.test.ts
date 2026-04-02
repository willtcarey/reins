/**
 * Tests for HighlightController — reactive controller that owns syntax
 * highlighting for a set of text lines.
 *
 * When `highlight` receives a new lines reference, text lines are sent to
 * the highlighter. The resulting HTML is stored on the controller.
 * Same-ref assignments are skipped.
 */
import { describe, test, expect } from "bun:test";
import { HighlightController } from "../controllers/highlight-controller.js";
import type { IHighlighter, HighlightHunkCallback } from "../models/changes/highlighter.js";
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

  highlightCode(_lang: string, code: string, onComplete: (html: string) => void): void {
    onComplete(`<span class="hl">${code}</span>`);
  }

  dispose(): void {
    this.disposed = true;
  }
}

class AsyncFakeHighlighter implements IHighlighter {
  pending: { path: string; lines: string[]; onComplete: HighlightHunkCallback }[] = [];
  disposed = false;

  highlightHunk(path: string, lines: string[], onComplete: HighlightHunkCallback): void {
    this.pending.push({ path, lines, onComplete });
  }

  highlightCode(_lang: string, code: string, onComplete: (html: string) => void): void {
    onComplete(`<span class="hl">${code}</span>`);
  }

  complete(index = this.pending.length - 1) {
    const req = this.pending[index];
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
      for (const c of Array.from(controllers)) c.hostDisconnected?.();
    },
    connect() {
      for (const c of Array.from(controllers)) c.hostConnected?.();
    },
  } satisfies ReactiveControllerHost & {
    updateCount: number;
    controllers: ReactiveController[];
    disconnect(): void;
    connect(): void;
  };
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

  test("highlight triggers the highlighter", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["hello"]);

    expect(hl.hunkCalls.length).toBe(1);
    expect(hl.hunkCalls[0].path).toBe("a.ts");
    expect(hl.hunkCalls[0].lines).toEqual(["hello"]);
  });

  test("highlight with null does not trigger the highlighter", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", null);
    expect(hl.hunkCalls.length).toBe(0);
  });

  test("same lines ref is skipped", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const lines = ["hello"];
    ctrl.highlight("a.ts", lines);
    ctrl.highlight("a.ts", lines); // same ref

    expect(hl.hunkCalls.length).toBe(1);
  });

  test("new lines ref triggers highlighting", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["v1"]);
    ctrl.highlight("a.ts", ["v2"]);

    expect(hl.hunkCalls.length).toBe(2);
    expect(hl.hunkCalls[1].lines).toEqual(["v2"]);
  });

  test("host.requestUpdate called when highlighting completes", () => {
    const host = fakeHost();
    const hl = new AsyncFakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["hello"]);

    expect(host.updateCount).toBe(0);
    hl.complete(0);
    expect(host.updateCount).toBe(1);
  });

  test("getLineHtml returns highlighted HTML after completion", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["hello"]);

    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">hello</span>');
  });

  test("getLineHtml returns undefined before completion", () => {
    const host = fakeHost();
    const hl = new AsyncFakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["hello"]);
    expect(ctrl.getLineHtml(0)).toBeUndefined();

    hl.complete(0);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">hello</span>');
  });

  test("getLineHtml returns undefined for out-of-range index", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["hello"]);
    expect(ctrl.getLineHtml(99)).toBeUndefined();
  });

  test("new lines clears stale HTML from previous call", () => {
    const host = fakeHost();
    const hl2 = new AsyncFakeHighlighter();
    const ctrl = new HighlightController(host, hl2);

    const lines1 = ["old"];
    ctrl.highlight("a.ts", lines1);
    hl2.complete(0);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">old</span>');

    // New lines — html should be cleared immediately (before callback)
    ctrl.highlight("a.ts", ["new"]);
    expect(ctrl.getLineHtml(0)).toBeUndefined();
  });

  test("stale callback does not set HTML for newer lines", () => {
    const host = fakeHost();
    const hl = new AsyncFakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["v1"]);
    ctrl.highlight("a.ts", ["v2"]);

    // Complete the FIRST (stale) callback — should NOT set htmlLines
    hl.complete(0);
    expect(ctrl.getLineHtml(0)).toBeUndefined();

    // Complete the second — should set htmlLines
    hl.complete(1);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">v2</span>');
  });

  test("hostDisconnected is safe (does not dispose shared highlighter)", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    new HighlightController(host, hl);

    expect(() => host.disconnect()).not.toThrow();
    expect(hl.disposed).toBe(false);
  });

  test("setting null after lines clears html", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["hello"]);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">hello</span>');

    ctrl.highlight("a.ts", null);
    expect(ctrl.getLineHtml(0)).toBeUndefined();
    expect(hl.hunkCalls.length).toBe(1);
  });

  test("re-highlight after expansion produces new HTML", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.highlight("a.ts", ["line1"]);
    expect(hl.hunkCalls.length).toBe(1);

    const expanded = ["line1", "line2"];
    ctrl.highlight("a.ts", expanded);

    expect(hl.hunkCalls.length).toBe(2);
    expect(hl.hunkCalls[1].lines).toEqual(["line1", "line2"]);
    expect(ctrl.getLineHtml(0)).toBe('<span class="hl">line1</span>');
    expect(ctrl.getLineHtml(1)).toBe('<span class="hl">line2</span>');
  });

  test("two controllers with same highlighter highlight independently", () => {
    const hl = new FakeHighlighter();
    const host1 = fakeHost();
    const host2 = fakeHost();
    const ctrl1 = new HighlightController(host1, hl);
    const ctrl2 = new HighlightController(host2, hl);

    ctrl1.highlight("a.ts", ["hello"]);
    ctrl2.highlight("b.ts", ["world"]);

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

    ctrl.highlight("src/main.py", ["x = 1"]);
    expect(hl.hunkCalls[0].path).toBe("src/main.py");
  });

  test("htmlLines getter returns the full array", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    expect(ctrl.htmlLines).toBeNull();

    ctrl.highlight("a.ts", ["a", "b"]);

    expect(ctrl.htmlLines).toEqual([
      '<span class="hl">a</span>',
      '<span class="hl">b</span>',
    ]);
  });
});
