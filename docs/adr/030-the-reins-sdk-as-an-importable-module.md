# ADR-030: The Reins SDK Is an Importable Module

- **Status:** Accepted
- **Date:** 2026-10-22
- **Author:** Will (with Claude)

## Context

The Reins SDK ([reins-sdk.md](../dev/reins-sdk.md)) is the frontend's host API: files, `workspace.open`, and the view and message-decorator contribution points. It was first built as an object that `app-shell` created and passed to each built-in feature's register function (`registerFileView(sdk)`, …).

That per-call injection fought the page-global custom element registry. A view's renderer names a custom element, which the Inspector creates and gives only `view` and `context`. An element is defined once per page, so the file view defined its element as a subclass capturing the files of the first SDK that registered it: the second SDK would silently get the first one's files. There is one Reins per page, so nothing called for more than one SDK there.

Later, external extensions will need the SDK too, without the host's code bundled into them, and possibly each with an instance of its own (its namespace, its disposal).

## Decision

**Features import the SDK from a module specifier, as VS Code extensions import `vscode`**: `import { reins } from "reins-sdk"`, and their types from `reins-sdk/contract`.

- **For built-ins the specifier resolves to one module in our own bundle** (`tsconfig.json` `paths`, which `tsc`, `bun build` and `bun test` resolve), so `reins` is in effect the page's one SDK, reached by an ordinary import.
- **`app-shell` installs the host into it once, at startup**, before it registers features or any element using `reins` connects: the SDK needs the app's long-lived state (`AppStore.files`, the session cache, the mounted workspace), so the module cannot create it. Using `reins` before installation throws a clear error; so does installing a second host. The host implementation stays private: the module exports only `reins`, and lint keeps features from importing the host or the app's stores.
- **Register functions take no argument**, and a feature's element is an ordinary custom element that reads `reins`.
- **Later, an external extension keeps `reins-sdk` external** when it is bundled, and a loader resolves the specifier for it, possibly to a per-extension instance. That loader is not built.

Rejected:

- **Per-call injection** (the SDK passed to register functions): it cannot reach elements the host creates without the capturing workaround above.
- **A global** (`globalThis.reins`): simple, but a global is one value for everything on the page and can never become per-extension; a specifier can be resolved differently for each importer.

## Consequences

- Built-in features read like extension code: an import and register functions without arguments. The file view's capturing subclass and `registerFileBrowser` (which only built a store) are gone.
- Order matters at startup: anything that uses `reins` before `app-shell` installs the host fails loudly rather than getting a half-made SDK.
- Tests install a host (`installTestHost`) into the same module; the frontend's test preload uninstalls it after every test, so a test cannot leak it into later ones.
- The host's own side (`app-shell`, `app-workspace`, the Inspector, messages) still gets the `ReinsHost` from `app-shell` and imports `reins-sdk/` by path; only features are bound to the specifier.
- Details: [reins-sdk.md](../dev/reins-sdk.md) *Access*; [frontend-architecture.md](../dev/frontend-architecture.md) *The Reins SDK*; [workspace-inspector.md](../plans/workspace-inspector.md) *Slice 2c*.
