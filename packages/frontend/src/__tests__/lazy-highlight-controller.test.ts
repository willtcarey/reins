/**
 * Tests for LazyHighlightController — combines IntersectionObserver-based
 * lazy activation with HighlightController and cache-key deduplication.
 *
 * Since we can't use a real IntersectionObserver in unit tests, we test
 * the highlight logic via connect() (which would normally be triggered by
 * visibility) and update() (triggered from willUpdate).
 */
import { describe, test, expect } from "bun:test";
import { LazyHighlightController } from "../controllers/lazy-highlight-controller.js";
import type { IHighlighter, HighlightHunkCallback } from "../models/changes/highlighter.js";
import type { DiffHunk, DiffLine } from "../models/changes/types.js";
import type { ReactiveController, ReactiveControllerHost } from "lit";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeHighlighter implements IHighlighter {
  calls: { path: string; lines: string[]; onComplete: HighlightHunkCallback }[] = [];
  disposed = false;

  highlightHunk(path: string, lines: string[], onComplete: HighlightHunkCallback): void {
    this.calls.push({ path, lines, onComplete });
    onComplete(lines.map((t) => `<hl>${t}</hl>`));
  }

  highlightCode(_lang: string, code: string, onComplete: (html: string) => void): void {
    onComplete(`<hl>${code}</hl>`);
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
    onComplete(`<hl>${code}</hl>`);
  }

  complete(index = this.pending.length - 1) {
    const req = this.pending[index];
    if (!req) return;
    req.onComplete(req.lines.map((t) => `<hl>${t}</hl>`));
  }

  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Fake host that doubles as an HTMLElement (with a no-op for
 * IntersectionObserver). The controller needs `ReactiveControllerHost & HTMLElement`.
 */
/** Minimal stub satisfying ReactiveControllerHost & HTMLElement for tests. */
interface FakeHost extends ReactiveControllerHost, HTMLElement {
  updateCount: number;
}

function fakeHost(): FakeHost {
  const controllers: ReactiveController[] = [];
  let updateCount = 0;
  const stub = {
    addController(c: ReactiveController) { controllers.push(c); },
    removeController(c: ReactiveController) {
      const i = controllers.indexOf(c);
      if (i >= 0) controllers.splice(i, 1);
    },
    requestUpdate() { updateCount++; },
    updateComplete: Promise.resolve(true),
    get updateCount() { return updateCount; },
    nodeType: 1,
    tagName: "DIV",
  };
  // Return the minimal stub as a FakeHost. Object.create copies the prototype
  // chain isn't needed — the controller only uses the properties above.
  const host: FakeHost = Object.create(stub);
  return host;
}

function line(type: DiffLine["type"], text: string, newLine?: number): DiffLine {
  return { type, text, newLine };
}

function hunk(lines: DiffLine[]): DiffHunk {
  return { header: "", lines };
}

// Helper: simulate the element becoming visible (connect triggers observer,
// which in real DOM fires intersection callback). Since we can't trigger
// IntersectionObserver in tests, we call update() after connect() — but
// the controller won't highlight until hasBeenVisible is true.
// Instead, we directly test via the controller's public API.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LazyHighlightController", () => {
  // -- Basic highlighting via update() ----------------------------------------

  test("update() does nothing before element is visible", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    let callCount = 0;
    const ctrl = new LazyHighlightController(
      host,
      () => { callCount++; return { path: "a.ts", hunk: hunk([line("add", "hello", 1)]) }; },
      hl,
    );

    ctrl.update();
    expect(callCount).toBe(0);
    expect(hl.calls.length).toBe(0);
  });

  test("hasBeenVisible is false initially", () => {
    const host = fakeHost();
    const hl = new FakeHighlighter();
    const ctrl = new LazyHighlightController(
      host,
      () => null,
      hl,
    );
    expect(ctrl.hasBeenVisible).toBe(false);
  });

  // -- Simulating visibility --------------------------------------------------
  // In real usage, the IntersectionObserver fires and sets hasBeenVisible.
  // We can't trigger that in unit tests, but we can test the post-visible
  // behavior by noting that connect() sets up the observer. To fully test
  // the highlight flow, we use a trick: we know the controller calls
  // _tryHighlight() internally. We'll test via a pattern that mirrors how
  // the tool blocks use it: the tool block calls connect() in connectedCallback
  // and update() in willUpdate. The first highlight happens when the observer
  // fires (which we can't simulate), but subsequent updates work via update().
  //
  // For thorough testing, we'll create a subclass that exposes visibility.

  function createVisibleController(
    getData: () => { path: string; hunk: DiffHunk } | null,
    hl: IHighlighter,
  ) {
    const host = fakeHost();
    const ctrl = new LazyHighlightController(host, getData, hl);
    // Force visibility by accessing internals — acceptable for testing
    ctrl["_hasBeenVisible"] = true;
    return { host, ctrl };
  }

  test("update() triggers highlighting after element becomes visible", () => {
    const hl = new FakeHighlighter();
    const { ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk([line("add", "hello", 1)]) }),
      hl,
    );

    ctrl.update();
    expect(hl.calls.length).toBe(1);
    expect(hl.calls[0].path).toBe("a.ts");
    expect(hl.calls[0].lines).toEqual(["hello"]);
  });

  test("getLineHtml returns highlighted HTML after update", () => {
    const hl = new FakeHighlighter();
    const { ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk([line("add", "hello", 1)]) }),
      hl,
    );

    ctrl.update();
    expect(ctrl.getLineHtml(0)).toBe("<hl>hello</hl>");
  });

  test("getLineHtml returns undefined before highlighting", () => {
    const hl = new AsyncFakeHighlighter();
    const { ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk([line("add", "hello", 1)]) }),
      hl,
    );

    ctrl.update();
    expect(ctrl.getLineHtml(0)).toBeUndefined();

    hl.complete(0);
    expect(ctrl.getLineHtml(0)).toBe("<hl>hello</hl>");
  });

  // -- Cache key deduplication ------------------------------------------------

  test("same data skips re-highlighting", () => {
    const hl = new FakeHighlighter();
    const { ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk([line("add", "hello", 1)]) }),
      hl,
    );

    ctrl.update();
    ctrl.update();
    ctrl.update();
    expect(hl.calls.length).toBe(1);
  });

  test("different line text triggers re-highlighting", () => {
    const hl = new FakeHighlighter();
    let text = "v1";
    const { ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk([line("add", text, 1)]) }),
      hl,
    );

    ctrl.update();
    expect(hl.calls.length).toBe(1);

    text = "v2";
    ctrl.update();
    expect(hl.calls.length).toBe(2);
    expect(hl.calls[1].lines).toEqual(["v2"]);
  });

  test("different path triggers re-highlighting", () => {
    const hl = new FakeHighlighter();
    let path = "a.ts";
    const { ctrl } = createVisibleController(
      () => ({ path, hunk: hunk([line("add", "hello", 1)]) }),
      hl,
    );

    ctrl.update();
    expect(hl.calls.length).toBe(1);

    path = "b.py";
    ctrl.update();
    expect(hl.calls.length).toBe(2);
    expect(hl.calls[1].path).toBe("b.py");
  });

  test("additional lines trigger re-highlighting", () => {
    const hl = new FakeHighlighter();
    let lines = [line("add", "a", 1)];
    const { ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk(lines) }),
      hl,
    );

    ctrl.update();
    expect(hl.calls.length).toBe(1);

    lines = [line("add", "a", 1), line("add", "b", 2)];
    ctrl.update();
    expect(hl.calls.length).toBe(2);
  });

  // -- Null getData -----------------------------------------------------------

  test("null getData skips highlighting", () => {
    const hl = new FakeHighlighter();
    const { ctrl } = createVisibleController(() => null, hl);

    ctrl.update();
    expect(hl.calls.length).toBe(0);
  });

  test("getData changing from null to data triggers highlighting", () => {
    const hl = new FakeHighlighter();
    let data: { path: string; hunk: DiffHunk } | null = null;
    const { ctrl } = createVisibleController(() => data, hl);

    ctrl.update();
    expect(hl.calls.length).toBe(0);

    data = { path: "a.ts", hunk: hunk([line("add", "hello", 1)]) };
    ctrl.update();
    expect(hl.calls.length).toBe(1);
  });

  // -- connect/disconnect lifecycle -------------------------------------------

  test("disconnect cleans up observer", () => {
    // Stub IntersectionObserver for this test since bun doesn't have it
    const origIO = globalThis.IntersectionObserver;
    let disconnected = false;
    Object.defineProperty(globalThis, "IntersectionObserver", {
      value: class {
        observe() {}
        unobserve() {}
        disconnect() { disconnected = true; }
        takeRecords() { return []; }
        root = null;
        rootMargin = "";
        thresholds = [];
      },
      writable: true,
      configurable: true,
    });

    try {
      const host = fakeHost();
      const hl = new FakeHighlighter();
      const ctrl = new LazyHighlightController(host, () => null, hl);

      ctrl.connect();
      ctrl.disconnect();
      expect(disconnected).toBe(true);

      // double disconnect is safe
      ctrl.disconnect();
    } finally {
      if (origIO) {
        globalThis.IntersectionObserver = origIO;
      } else {
        globalThis.IntersectionObserver = undefined!;
      }
    }
  });

  test("connect is idempotent after visibility", () => {
    const hl = new FakeHighlighter();
    const { ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk([line("add", "hello", 1)]) }),
      hl,
    );

    // connect after already visible should be a no-op
    ctrl.connect();
    expect(hl.calls.length).toBe(0); // no spurious highlighting from connect
  });

  // -- host.requestUpdate on completion ---------------------------------------

  test("host.requestUpdate is called when highlighting completes", () => {
    const hl = new AsyncFakeHighlighter();
    const { host, ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk([line("add", "hello", 1)]) }),
      hl,
    );

    ctrl.update();
    expect(host.updateCount).toBe(0);

    hl.complete(0);
    expect(host.updateCount).toBe(1);
  });

  // -- Key derived from line text, not type or line numbers -------------------

  test("same text with different line type does not re-highlight", () => {
    const hl = new FakeHighlighter();
    let type: DiffLine["type"] = "add";
    const { ctrl } = createVisibleController(
      () => ({ path: "a.ts", hunk: hunk([{ type, text: "hello", newLine: 1 }]) }),
      hl,
    );

    ctrl.update();
    expect(hl.calls.length).toBe(1);

    // Change type but not text — key is derived from text only
    type = "remove";
    ctrl.update();
    // Key is path + line texts, so same text = same key = skip
    expect(hl.calls.length).toBe(1);
  });
});
