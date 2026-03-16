/**
 * Tests for HighlightController — reactive controller that owns the
 * Highlighter and triggers re-highlighting when files change.
 *
 * Uses a WeakSet<DiffFile> internally to track which file objects have
 * already been highlighted — only new/dirty file objects are sent to
 * the highlighter.
 */
import { describe, test, expect } from "bun:test";
import { HighlightController } from "../controllers/highlight-controller.js";
import type { IHighlighter, HighlightCallback } from "../changes/highlighter.js";
import type { DiffFile, DiffLine } from "../changes/types.js";
import type { ReactiveController, ReactiveControllerHost } from "lit";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeHighlighter implements IHighlighter {
  calls: { files: DiffFile[]; onComplete: HighlightCallback }[] = [];
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

  dispose(): void {
    this.disposed = true;
  }
}

class AsyncFakeHighlighter implements IHighlighter {
  pending: { files: DiffFile[]; onComplete: HighlightCallback }[] = [];
  disposed = false;

  highlight(files: DiffFile[], onComplete: HighlightCallback): void {
    this.pending.push({ files, onComplete });
  }

  complete(index = this.pending.length - 1) {
    const req = this.pending[index];
    if (!req) return;
    for (const file of req.files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          line.html = `<span class="hl">${line.text}</span>`;
        }
      }
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

function makeFile(path: string, hunks: { header: string; lines: DiffLine[] }[]): DiffFile {
  return { path, additions: 0, removals: 0, hunks };
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

  test("setting files highlights all files (none in WeakSet yet)", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const files = [
      makeFile("a.ts", [{ header: "@@", lines: [line("add", "hello", 1, 1)] }]),
      makeFile("b.ts", [{ header: "@@", lines: [line("add", "world", 1, 1)] }]),
    ];
    ctrl.files = files;

    expect(hl.calls.length).toBe(1);
    expect(hl.calls[0].files).toEqual(files);
    expect(hl.calls[0].files.length).toBe(2);
  });

  test("setting empty files does not trigger highlighting", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    ctrl.files = [];
    expect(hl.calls.length).toBe(0);
  });

  test("host.requestUpdate is called when highlighting completes", () => {
    const host = fakeHost();
    const hl = new AsyncFakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const files = [makeFile("a.ts", [{ header: "@@", lines: [line("add", "hello", 1, 1)] }])];
    ctrl.files = files;

    expect(host.updateCount).toBe(0);
    hl.complete();
    expect(host.updateCount).toBe(1);
  });

  test("line.html is populated after highlighting completes", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const myLine = line("add", "hello", 1, 1);
    const files = [makeFile("a.ts", [{ header: "@@", lines: [myLine] }])];
    ctrl.files = files;

    expect(myLine.html).toBe('<span class="hl">hello</span>');
  });

  test("same array reference is skipped (no redundant highlighting)", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const files = [makeFile("a.ts", [{ header: "@@", lines: [line("add", "hello", 1, 1)] }])];
    ctrl.files = files;
    ctrl.files = files; // same ref

    expect(hl.calls.length).toBe(1);
  });

  test("new array ref with same file objects skips already-highlighted files", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const fileA = makeFile("a.ts", [{ header: "@@", lines: [line("add", "hello", 1, 1)] }]);
    const fileB = makeFile("b.ts", [{ header: "@@", lines: [line("add", "world", 1, 1)] }]);
    const files = [fileA, fileB];
    ctrl.files = files;

    expect(hl.calls.length).toBe(1);

    // New array, same file objects — everything is already highlighted
    ctrl.files = [fileA, fileB];

    // No additional highlight call — both files are in the WeakSet
    expect(hl.calls.length).toBe(1);
  });

  test("new file objects are highlighted even if path is the same (e.g. re-fetch)", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const files1 = [makeFile("a.ts", [{ header: "@@", lines: [line("add", "v1", 1, 1)] }])];
    ctrl.files = files1;

    // Re-fetch produces entirely new file objects
    const files2 = [makeFile("a.ts", [{ header: "@@", lines: [line("add", "v2", 1, 1)] }])];
    ctrl.files = files2;

    expect(hl.calls.length).toBe(2);
    expect(hl.calls[1].files).toEqual(files2);
  });

  test("mix of old and new file objects — only new ones are sent to highlighter", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const fileA = makeFile("a.ts", [{ header: "@@", lines: [line("add", "hello", 1, 1)] }]);
    const fileB = makeFile("b.ts", [{ header: "@@", lines: [line("add", "world", 1, 1)] }]);
    ctrl.files = [fileA, fileB];

    expect(hl.calls.length).toBe(1);

    // fileA stays the same, fileB is a new object (e.g. after expandHunk)
    const fileBNew = makeFile("b.ts", [{ header: "@@", lines: [line("add", "world expanded", 1, 1)] }]);
    ctrl.files = [fileA, fileBNew];

    expect(hl.calls.length).toBe(2);
    // Only the new file was sent
    expect(hl.calls[1].files.length).toBe(1);
    expect(hl.calls[1].files[0]).toBe(fileBNew);
  });

  test("after expand, store produces new file object — that file gets re-highlighted", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    const fileA = makeFile("a.ts", [{ header: "@@", lines: [line("add", "hello", 1, 1)] }]);
    const fileB = makeFile("b.ts", [{ header: "@@", lines: [line("context", "line1", 1, 1)] }]);
    ctrl.files = [fileA, fileB];

    expect(hl.calls.length).toBe(1);

    // Simulate what the store does: shallow-copy the mutated file, new array
    const fileBExpanded = { ...fileB };
    fileBExpanded.hunks[0].lines.push(line("context", "line2", 2, 2));
    ctrl.files = [fileA, fileBExpanded];

    expect(hl.calls.length).toBe(2);
    expect(hl.calls[1].files.length).toBe(1);
    expect(hl.calls[1].files[0]).toBe(fileBExpanded);
  });

  test("hostDisconnected is safe (does not dispose shared highlighter)", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new HighlightController(host, hl);

    expect(() => host.disconnect()).not.toThrow();
    expect(hl.disposed).toBe(false);
  });
});
