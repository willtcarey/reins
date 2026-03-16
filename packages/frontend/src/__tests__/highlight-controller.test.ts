/**
 * Tests for HighlightController — reactive controller that owns syntax
 * highlighting for a single DiffHunk.
 *
 * Each diff-hunk creates its own HighlightController instance.
 * When `setHunk` receives a new hunk reference, it is sent to the
 * shared highlighter. Same-ref assignments are skipped.
 */
import { describe, test, expect } from "bun:test";
import { HighlightController } from "../controllers/highlight-controller.js";
import type { IHighlighter, HighlightCallback } from "../changes/highlighter.js";
import type { DiffFile, DiffHunk, DiffLine } from "../changes/types.js";
import type { ReactiveController, ReactiveControllerHost } from "lit";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeHighlighter implements IHighlighter {
  calls: { files: DiffFile[]; onComplete: HighlightCallback }[] = [];
  hunkCalls: { path: string; hunk: DiffHunk; onComplete: HighlightCallback }[] = [];
  disposed = false;

  highlight(files: DiffFile[], onComplete: HighlightCallback): void {
    this.calls.push({ files, onComplete });
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          line.html = `<span class="hl">${line.text}</span>`;
        }
      }
    }
    onComplete();
  }

  highlightHunk(path: string, hunk: DiffHunk, onComplete: HighlightCallback): void {
    this.hunkCalls.push({ path, hunk, onComplete });
    for (const line of hunk.lines) {
      line.html = `<span class="hl">${line.text}</span>`;
    }
    onComplete();
  }

  dispose(): void {
    this.disposed = true;
  }
}

class AsyncFakeHighlighter implements IHighlighter {
  pending: { files: DiffFile[]; onComplete: HighlightCallback }[] = [];
  pendingHunks: { path: string; hunk: DiffHunk; onComplete: HighlightCallback }[] = [];
  disposed = false;

  highlight(files: DiffFile[], onComplete: HighlightCallback): void {
    this.pending.push({ files, onComplete });
  }

  highlightHunk(path: string, hunk: DiffHunk, onComplete: HighlightCallback): void {
    this.pendingHunks.push({ path, hunk, onComplete });
  }

  completeHunk(index = this.pendingHunks.length - 1) {
    const req = this.pendingHunks[index];
    if (!req) return;
    for (const line of req.hunk.lines) {
      line.html = `<span class="hl">${line.text}</span>`;
    }
    req.onComplete();
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
    expect(hl.hunkCalls[0].hunk).toBe(hunk);
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
    expect(hl.hunkCalls[1].hunk).toBe(hunk2);
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

  test("line.html is populated after highlighting completes", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const myLine = line("add", "hello", 1, 1);
    const hunk = makeHunk("@@", [myLine]);
    ctrl.setHunk("a.ts", hunk);

    expect(myLine.html).toBe('<span class="hl">hello</span>');
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

  test("setting null after a hunk clears the reference", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "hello", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);
    ctrl.setHunk("a.ts", null);

    expect(ctrl.hunk).toBeNull();
    // Only one highlight call (for the initial set)
    expect(hl.hunkCalls.length).toBe(1);
  });

  test("after expand, store produces new hunk — gets re-highlighted", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("context", "line1", 1, 1)]);
    ctrl.setHunk("a.ts", hunk);

    expect(hl.hunkCalls.length).toBe(1);

    // Simulate what the store does: the file is shallow-copied so hunks
    // array is shared, but the hunk object itself may be new after merge.
    const hunkExpanded = { ...hunk };
    hunkExpanded.lines = [...hunk.lines, line("context", "line2", 2, 2)];
    ctrl.setHunk("a.ts", hunkExpanded);

    expect(hl.hunkCalls.length).toBe(2);
    expect(hl.hunkCalls[1].hunk).toBe(hunkExpanded);
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
  });

  test("file path is passed through to the highlighter for language detection", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const hunk = makeHunk("@@", [line("add", "x = 1", 1, 1)]);
    ctrl.setHunk("src/main.py", hunk);

    expect(hl.hunkCalls[0].path).toBe("src/main.py");
  });
});
