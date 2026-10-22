# The Reins SDK

The Reins SDK is the host API through which built-in frontend features get everything they use: a source's files, opening views in the workspace, and the contribution points for views and message decorators. Features import it, `import { reins } from "reins-sdk"`, as a VS Code extension imports `vscode`. It is the "Reins-owned seam" stage of [extension-architecture.md](extension-architecture.md) (*Interface maturity*): an explicit interface with Reins values, used by built-in code. It is not a plugin system yet; see *Not built yet*.

## Where it lives

`packages/frontend/src/reins-sdk/`:

- **`index.ts`** — the module behind the `reins-sdk` specifier: it exports `reins`, the SDK, whose capabilities are read from the installed host on each use. It exports nothing else.
- **`contract.ts`** — the contract, imported as `reins-sdk/contract`: every type a feature may use (`ReinsSdk` and its capabilities, `Source`, `View` with `viewKey` and `parseView`, `ViewRenderer`, `ViewElement`, `MessageDecorator`, `WorkspaceContext`, `IconName`) and a few pure helpers (`sameSource`). It imports nothing (lint: `reins/sdk-contract-isolation`), so it can become a types package. Its values are Reins values: never Lit templates, marked tokens, HTML, stores, routes or transport types. Each member's comment states its behavior (lifecycle, ordering, what is synchronous); keep them accurate when the host changes.
- **`host.ts`** — `ReinsHost`, the implementation: it builds the frozen `sdk` object, keeps the registered view renderers and message decorators, and forwards `workspace.open` to the workspace on screen. Its other methods are for the host's own components: `mountWorkspace`, `renderer(view)` (the Inspector), `decorations(source)` (messages), `subscribe`. `installHost(host)` makes a host the page's, the one `reins` reaches.
- **`decorations.ts`** — `MessageDecorations`, the registered decorators applied for one context (splitting prose, plain text and inline code by their spans).

## Access

[ADR-030](../adr/030-the-reins-sdk-as-an-importable-module.md) records this choice.

- **Features import the SDK from a module specifier**, as VS Code extensions import `vscode`: `import { reins } from "reins-sdk"` for the SDK, `import type { … } from "reins-sdk/contract"` for its types (and `reins-sdk/contract` for its few pure helpers, such as `sameSource`). Both are aliases in `packages/frontend/tsconfig.json` (`paths`), which `tsc`, `bun build` and `bun test` all resolve: for built-ins they resolve to `reins-sdk/index.ts` and `reins-sdk/contract.ts` in our own bundle, so `reins` is the page's one SDK through an ordinary import. There is one Reins per page.
- **`app-shell` installs the host once, at startup.** The SDK needs the app's long-lived state (`AppStore.files`, the session cache through it, the mounted workspace), so `app-shell` (`components/app.ts`) creates the `ReinsHost` over `AppStore.files` and, in its `connectedCallback`, installs it (`installHost`) before it registers the features and before any element that uses `reins` connects. It undoes all of it when it disconnects. Using `reins` before installation throws ("used before app-shell installed its host"); installing a second host throws too. The host stays private behind the module: `reins-sdk` exports only `reins`, and features never import `host.ts`.
- **A feature uses only what the SDK gives it.** It imports `reins-sdk`, `reins-sdk/contract` and its own modules, never a path into `reins-sdk/` (the host, the decorations, the index or the contract by path), `AppStore`, `WorkspaceStore`, `ProjectFiles`, `SessionCache` or another feature's internals (lint: `reins/features-through-sdk`, configured in `.oxlintrc.json` for the feature files). The host's own side (`app-shell`, `app-workspace`, the Inspector, messages) is the app and imports `reins-sdk/` by path; it reaches the host's methods through the `ReinsHost` app-shell gives it.
- **Register functions take no argument** and return a disposer; `app-shell` calls them at startup and disposes them when it disconnects. A feature's custom element is defined like any other (`@customElement`) and reads `reins` when it renders.
- **Not a global, and not handed in.** A global (`globalThis.reins`) could never become per-extension. Handing the SDK object to each register function fought the page-global custom element registry: a view's element is defined once per page and created by the Inspector, so it could only get capabilities by capturing the first SDK in a subclass. With a specifier, built-ins resolve it to the page's one instance, and a later loader can resolve it for each external extension (see *Not built yet*).

The built-in features:

| Feature | Register function | Uses |
|---|---|---|
| File view (the Inspector's `file` view) | `registerFileView()` in `components/file-view/file-view.ts` | `files`, `views.register` |
| File references in messages | `registerFileReferences()` in `models/file-references.ts` | `files`, `messages.registerDecorator` |
| File browser and file search | none: `app-shell` creates its `FileBrowserStore` (`models/stores/file-browser-store.ts`) | `files`, `workspace.open` |

The file browser has no contribution point for overlays: `app-shell` creates its `FileBrowserStore`, which reads `reins`, mounts it (`<file-browser>`, `<file-search>`) and opens it on the `open-in-browser`, `open-file-browser` and `open-file-search` events.

**In tests**, `installTestHost(options)` (`__tests__/helpers/reins-sdk.ts`) installs a host whose files API knows a source and whose mounted workspace records what `workspace.open` reaches it with; tests then use `reins` as features do. The frontend's test preload (`packages/frontend/bunfig.toml`, `__tests__/helpers/test-setup.ts`) uninstalls it after every test, so no test leaves its host to a later one, and installing again within a test replaces it.

## Capabilities

- **`files`** — a source's files (`Files`). It is `ProjectFiles` (`models/stores/project-files.ts`, application lifetime on `AppStore`) itself: the SDK adds no layer. A `Source` is `{ nodeId, path }`; the host works out how to reach it (today the project file routes, through the project of the sessions placed on it) and whether its node is connected, from `SessionCache`, so features never see a project ID or availability. `listing(source)` is synchronous and cached, loads on first ask, reloads on the change signal and when the node comes back, is empty while the node is offline, and keeps its `data` array when a reload finds the same files. `subscribe` hears any listing change; `onFilesChanged` says a source's files may have changed (debounced); `read` is uncached; `contentUrl` is null for an unknown source.
- **`workspace.open(view, { in, source? })`** — shows a view in a container of the workspace on screen (only `"inspector"` exists): a view with the same `viewKey` that is open is focused and replaced, otherwise it opens after the others. `app-workspace` mounts itself into the host while connected; on a phone it moves to the Inspector page. A caller outside the workspace names the view's `source`: the host resolves its project and the workspace ignores a view of another project. Nothing happens while no workspace is shown (settings, History).

## Contribution points

- **`views.register(name, renderer)`** — the renderer of a view name: `title(view)`, `description(view)`, an `icon` (an `IconName`, drawn by the host from `ui/icons.ts`) and `element`, a custom element name. The Inspector (`workspace-inspector`) creates that element for each tab of the view and sets `view` and `context` (`WorkspaceContext`: the viewed session's source, nothing more). Every open sets a new `view` object, so an element treats a new object as "show this afresh" (the file view reads its file again and reveals its lines). A name has one renderer; registering `changes`, a second renderer or an element name without a hyphen throws. A tab whose view has no renderer shows as unavailable. A feature's element reads `reins` itself (the file view reads `reins.files`).
- **`messages.registerDecorator(decorator)`** — turns pieces of completed message text into controls that open views in the Inspector. `decorate(text, context)` returns spans (`start`, `end`, the `view` each opens and a `label`), `decorateCode(code, context)` optionally decorates a whole inline-code span, and `onChange(listener)` says when what it decorates from changed. Decorating is synchronous, from what the decorator has; the host decorates again after `onChange` (it bumps a generation, so `ReinsHost.decorations(source)` returns a new `MessageDecorations` and messages parse again), and returns the same object otherwise, so rendered messages keep their HTML. The host applies decorators (`components/message-decorations.ts`): the marked token walk for Markdown (never code blocks, HTML, links or images), plain-text segments for user messages, rendering as buttons around the original text, and activation through `workspace.open`. Messages still streaming are not decorated, and the message text, copied Markdown and provider history never see decorations. Where decorators overlap, the earlier registered wins.

## The Changes tab exception

The Inspector's Changes tab (the changed-files tree) is not a registered view: it is the Inspector's own pinned first tab, rendered by `app-workspace` and handed to `workspace-inspector` as `changes`. It needs `DiffStore` and `CodeReviewStore`, which are not SDK capabilities. `{ view: "changes" }` stays a `View` (it can be opened, which focuses it), and `views.register("changes", …)` throws. It becomes a registered view only if diffs and review become capabilities.

## Not built yet

Deliberately left out until there are external extensions:

- **Activation** — loading, ordering, failure state and disposal of extensions; today `app-shell` calls the built-in register functions directly.
- **Per-extension resolution** — an external extension would keep `reins-sdk` external when it is bundled, and a loader would resolve the specifier for it, possibly to an instance of its own (its namespace, its disposal), so nothing of the host is bundled into it. Today the specifier is a `tsconfig` alias to the page's one instance.
- **Namespacing** — view names and decorator identity per extension (`"<plugin>:<name>"`); today `ViewParameters` is a closed interface (exported, so a later package can augment it).
- **A types package** — `contract.ts` is ready to move, but is not published.
- **Versioning** — no compatibility promise; the contract changes with the app.
- **A loader** — no discovery, bundles or manifests ([pinned-plugin-apps.md](../plans/pinned-plugin-apps.md)).
- **Further capabilities** — opening the file browser is still the `open-in-browser` event, not an SDK call; diffs, review, sessions and overlays are not capabilities.
