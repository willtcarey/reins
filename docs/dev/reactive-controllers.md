# Reactive Controllers

How and when to use Lit [Reactive Controllers](https://lit.dev/docs/composition/controllers/) to extract testable logic from components.

## The Problem

Our components accumulate `@state()` properties and private methods that mix business logic with rendering. This logic can't be tested without instantiating the full web component in a browser.

Example — `diff-panel.ts` has 7 `@state()` properties and ~20 private methods managing:
- File collapse/expand state
- Markdown preview toggle + cache + fetch
- Copy-to-clipboard with timed confirmation
- Expand-hunk loading keys
- Scroll spy active file

None of this is testable with bun:test today.

## Controllers vs. Stores

We have two patterns for state management. Use the right one:

| | Stores (pubsub) | Reactive Controllers |
|---|---|---|
| **Scope** | Shared across components | Per-component instance |
| **Lifetime** | App or feature lifetime | Tied to host component lifecycle |
| **Notification** | `subscribe()` / `notify()` | `host.requestUpdate()` |
| **Testing** | Instantiate directly | Instantiate with a fake host |
| **Examples** | `DiffStore`, `FileTreeState`, `AppStore` | (new) `MarkdownPreviewController`, `CollapseController` |

**Rule of thumb:** If multiple components need the same state, use a store. If the state is private to one component, use a controller.

## StoreController — Generic Store Subscription

`controllers/store-controller.ts` provides a generic reactive controller that subscribes to any store implementing our `{ subscribe(fn: () => void): () => void }` pattern. It eliminates the need for manual `@state() _storeVersion` counters or prop-drilled version values.

```ts
import { StoreController } from "../controllers/store-controller.js";
import type { DiffStore } from "../stores/diff-store.js";

@customElement("my-component")
export class MyComponent extends LitElement {
  private _storeCtrl = new StoreController<DiffStore>(this);

  @property({ attribute: false })
  set store(s: DiffStore | null) { this._storeCtrl.store = s; }
  get store(): DiffStore | null { return this._storeCtrl.store; }
}
```

The `Subscribable` interface is intentionally minimal — it works with `DiffStore`, `AppStore`, `FileTreeState`, or any future store. The controller handles subscribe/unsubscribe on store change, `hostDisconnected`, and `hostConnected` (re-subscribe after move).

## Two Kinds of Controllers

### State controllers
Extract a cluster of `@state()` properties and the methods that mutate them. No DOM interaction. These are the simplest to write and test.

**Examples:** `CollapseController`, `MarkdownPreviewController`, `ClipboardController`

### Behavior controllers
Encapsulate a pattern of state + DOM interaction + lifecycle management. They use `hostConnected`, `hostDisconnected`, and `hostUpdated` to wire up event listeners, observers, and timers — the same boilerplate that currently litters component lifecycle methods.

**Examples:** `AutoScrollController` (scroll-to-bottom on new messages), `ScrollSpyController` (track which element is in view), `AsyncActionController` (loading key tracking with automatic cleanup)

```ts
// Behavior controller example — auto-scroll to bottom of a container
import type { ReactiveController, ReactiveControllerHost } from "lit";

export class AutoScrollController implements ReactiveController {
  private host: ReactiveControllerHost;
  private container: HTMLElement | null = null;
  private listener: (() => void) | null = null;

  /** True when the user has scrolled up from the bottom. */
  userScrolledAway = false;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  /** Call after each render to (re-)attach to the scroll container. */
  attach(el: HTMLElement | null) {
    if (el === this.container) return;
    this.detach();
    if (!el) return;
    this.container = el;
    this.listener = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      this.userScrolledAway = scrollHeight - scrollTop - clientHeight > 40;
    };
    el.addEventListener("scroll", this.listener, { passive: true });
  }

  /** Scroll to bottom if the user hasn't scrolled away. */
  scrollIfFollowing() {
    if (!this.userScrolledAway && this.container) {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  hostConnected() {}

  hostDisconnected() {
    this.detach();
  }

  private detach() {
    if (this.container && this.listener) {
      this.container.removeEventListener("scroll", this.listener);
    }
    this.container = null;
    this.listener = null;
  }
}
```

Testing behavior controllers follows the same fake-host pattern. For DOM-interacting methods like `attach()`, either:
- Test the state logic only (e.g., verify `userScrolledAway` after simulating events)
- Pass a minimal fake element (a plain object with `addEventListener`, `scrollTop`, etc.)
- Accept that some DOM wiring is only tested via manual/integration testing

The goal isn't 100% unit coverage of DOM code — it's to get the **state machine and decision logic** out of the component and into a testable place.

## Writing a Controller

```ts
// changes/markdown-preview-controller.ts
import type { ReactiveController, ReactiveControllerHost } from "lit";

export class MarkdownPreviewController implements ReactiveController {
  renderedFiles = new Set<string>();
  cache = new Map<string, string>();
  loading = new Set<string>();

  private host: ReactiveControllerHost;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {}
  hostDisconnected() {
    this.reset();
  }

  isRendered(path: string): boolean {
    return this.renderedFiles.has(path);
  }

  async toggle(path: string, fetchUrl: string | null) {
    if (this.renderedFiles.has(path)) {
      this.renderedFiles = new Set(this.renderedFiles);
      this.renderedFiles.delete(path);
      this.host.requestUpdate();
      return;
    }
    this.renderedFiles = new Set(this.renderedFiles).add(path);
    if (!this.cache.has(path) && fetchUrl) {
      await this.fetch(path, fetchUrl);
    }
    this.host.requestUpdate();
  }

  reset() {
    this.renderedFiles = new Set();
    this.cache = new Map();
    this.loading = new Set();
  }

  // ... fetch logic
}
```

## Using a Controller in a Component

```ts
@customElement("diff-panel")
export class DiffPanel extends LitElement {
  @property({ attribute: false }) store: DiffStore | null = null;

  // Controllers replace @state() + private methods
  private markdown = new MarkdownPreviewController(this);
  private collapse = new CollapseController(this);
  private clipboard = new ClipboardController(this);

  override render() {
    // Read state from controllers
    const isRendered = this.markdown.isRendered(file.path);
    const isCollapsed = this.collapse.isCollapsed(file.path);
    // ...
  }
}
```

The component becomes a thin wiring layer: it owns controllers, passes data from stores, and renders templates. No business logic in the component itself.

## Testing a Controller

Controllers are tested with a **fake host** — no DOM, no browser, just bun:test:

```ts
// __tests__/markdown-preview-controller.test.ts
import { describe, test, expect } from "bun:test";
import { MarkdownPreviewController } from "../changes/markdown-preview-controller.js";

/** Minimal fake that satisfies ReactiveControllerHost. */
function fakeHost(): ReactiveControllerHost {
  return {
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  };
}

describe("MarkdownPreviewController", () => {
  test("toggle adds file to rendered set", async () => {
    const ctrl = new MarkdownPreviewController(fakeHost());
    await ctrl.toggle("README.md", "/fake");
    expect(ctrl.isRendered("README.md")).toBe(true);
  });

  test("double toggle removes file", async () => {
    const ctrl = new MarkdownPreviewController(fakeHost());
    await ctrl.toggle("README.md", "/fake");
    await ctrl.toggle("README.md", "/fake");
    expect(ctrl.isRendered("README.md")).toBe(false);
  });

  test("reset clears all state", async () => {
    const ctrl = new MarkdownPreviewController(fakeHost());
    await ctrl.toggle("README.md", "/fake");
    ctrl.reset();
    expect(ctrl.isRendered("README.md")).toBe(false);
    expect(ctrl.cache.size).toBe(0);
  });
});
```

### Fake Host Helper

Put this in a shared test utility so all controller tests can use it:

```ts
// __tests__/helpers.ts
import type { ReactiveControllerHost } from "lit";

export function fakeHost(): ReactiveControllerHost {
  const controllers: any[] = [];
  return {
    addController(c: any) { controllers.push(c); },
    removeController(c: any) {
      const i = controllers.indexOf(c);
      if (i >= 0) controllers.splice(i, 1);
    },
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  };
}
```

### Testing Fetch Logic

Use the same `mockFetch` / `jsonResponse` pattern from existing store tests:

```ts
test("fetch caches rendered markdown", async () => {
  mockFetch(() => new Response("# Hello"));
  const ctrl = new MarkdownPreviewController(fakeHost());
  await ctrl.toggle("doc.md", "/api/file?path=doc.md");
  expect(ctrl.cache.has("doc.md")).toBe(true);
  expect(ctrl.cache.get("doc.md")).toContain("<h1>");
});
```

## Migration Guide

When refactoring a component to use controllers:

1. **Identify clusters** of `@state()` + methods that form a coherent behavior (toggle, fetch+cache, timed confirmation, etc.).
2. **Extract to a controller class** — move the state and methods, replace `this.requestUpdate()` with `this.host.requestUpdate()`.
3. **Write tests first** (per [workflow.md](workflow.md) — red/green/refactor). Define the controller's contract in tests, then implement.
4. **Replace in the component** — swap `@state()` properties for controller reads, swap method calls for controller method calls.
5. **Remove the `@state()` declarations** — the controller calls `requestUpdate()` itself.

## What Stays in Components

- **Rendering** — `render()`, template helpers, CSS classes
- **DOM interaction** — `querySelector`, `scrollIntoView`, `scrollTop` adjustment
- **Event wiring** — `@click`, `@keydown` handlers that delegate to controllers/stores
- **Store subscriptions** — `connectedCallback` / `disconnectedCallback` subscribe/unsubscribe
- **ScrollSpy** — inherently DOM-coupled, stays on the component

## What Stays in Stores

- **Shared data** — anything multiple components read (`DiffStore`, `AppStore`, `FileTreeState`)
- **Server communication** — fetch, polling, WebSocket event handling
- **Cross-component coordination** — e.g., AppStore telling DiffStore to refresh after agent_end
