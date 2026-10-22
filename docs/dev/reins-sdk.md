# The Reins SDK

The Reins SDK is the host API object through which built-in frontend features get everything they use: a source's files, opening views in the workspace, and the contribution points for views and message decorators. It is the "Reins-owned seam" stage of [extension-architecture.md](extension-architecture.md) (*Interface maturity*): an explicit interface with Reins values, used by built-in code. It is not a plugin system yet; see *Not built yet*.

## Where it lives

`packages/frontend/src/reins-sdk/`:

- **`contract.ts`** — the contract: every type a feature may use (`ReinsSdk` and its capabilities, `Source`, `View` with `viewKey` and `parseView`, `ViewRenderer`, `ViewElement`, `MessageDecorator`, `WorkspaceContext`, `IconName`) and a few pure helpers (`sameSource`). It imports nothing (lint: `reins/sdk-contract-isolation`), so it can become a types package. Its values are Reins values: never Lit templates, marked tokens, HTML, stores, routes or transport types. Each member's comment states its behavior (lifecycle, ordering, what is synchronous); keep them accurate when the host changes.
- **`host.ts`** — `ReinsHost`, the implementation: it builds the frozen `sdk` object, keeps the registered view renderers and message decorators, and forwards `workspace.open` to the workspace on screen. Its other methods are for the host's own components: `mountWorkspace`, `renderer(view)` (the Inspector), `decorations(source)` (messages), `subscribe`.
- **`decorations.ts`** — `MessageDecorations`, the registered decorators applied for one context (splitting prose, plain text and inline code by their spans).

## Access

- **One SDK object, created at the composition root.** `app-shell` (`components/app.ts`) creates the `ReinsHost` over `AppStore.files` and calls each built-in feature's register function with `host.sdk` at startup. There is no global, and no feature imports an instance.
- **A feature uses only what the SDK gives it.** It imports the contract and its own modules, never `AppStore`, `WorkspaceStore`, `ProjectFiles`, `SessionCache`, the host, or another feature's internals (lint: `reins/features-through-sdk`, configured in `.oxlintrc.json` for the feature files).
- **Registrations return a disposer.** `app-shell` disposes the features and the host when it disconnects.

The built-in features:

| Feature | Register function | Uses |
|---|---|---|
| File view (the Inspector's `file` view) | `registerFileView(sdk)` in `components/file-view/file-view.ts` | `files`, `views.register` |
| File references in messages | `registerFileReferences(sdk)` in `models/file-references.ts` | `files`, `messages.registerDecorator` |
| File browser and file search | `registerFileBrowser(sdk)` in `models/stores/file-browser-store.ts` | `files`, `workspace.open` |

The file browser has no contribution point for overlays: its register function returns its `FileBrowserStore`, which `app-shell` mounts (`<file-browser>`, `<file-search>`) and opens on the `open-in-browser`, `open-file-browser` and `open-file-search` events.

## Capabilities

- **`files`** — a source's files (`Files`). It is `ProjectFiles` (`models/stores/project-files.ts`, application lifetime on `AppStore`) itself: the SDK adds no layer. A `Source` is `{ nodeId, path }`; the host works out how to reach it (today the project file routes, through the project of the sessions placed on it) and whether its node is connected, from `SessionCache`, so features never see a project ID or availability. `listing(source)` is synchronous and cached, loads on first ask, reloads on the change signal and when the node comes back, is empty while the node is offline, and keeps its `data` array when a reload finds the same files. `subscribe` hears any listing change; `onFilesChanged` says a source's files may have changed (debounced); `read` is uncached; `contentUrl` is null for an unknown source.
- **`workspace.open(view, { in, source? })`** — shows a view in a container of the workspace on screen (only `"inspector"` exists): a view with the same `viewKey` that is open is focused and replaced, otherwise it opens after the others. `app-workspace` mounts itself into the host while connected; on a phone it moves to the Inspector page. A caller outside the workspace names the view's `source`: the host resolves its project and the workspace ignores a view of another project. Nothing happens while no workspace is shown (settings, History).

## Contribution points

- **`views.register(name, renderer)`** — the renderer of a view name: `title(view)`, `description(view)`, an `icon` (an `IconName`, drawn by the host from `ui/icons.ts`) and `element`, a custom element name. The Inspector (`workspace-inspector`) creates that element for each tab of the view and sets `view` and `context` (`WorkspaceContext`: the viewed session's source, nothing more). Every open sets a new `view` object, so an element treats a new object as "show this afresh" (the file view reads its file again and reveals its lines). A name has one renderer; registering `changes`, a second renderer or an element name without a hyphen throws. A tab whose view has no renderer shows as unavailable. A feature's element gets capabilities from its register function's closure (the file view defines its element once per page, bound to the first SDK that registers it, since a custom element cannot be defined twice).
- **`messages.registerDecorator(decorator)`** — turns pieces of completed message text into controls that open views in the Inspector. `decorate(text, context)` returns spans (`start`, `end`, the `view` each opens and a `label`), `decorateCode(code, context)` optionally decorates a whole inline-code span, and `onChange(listener)` says when what it decorates from changed. Decorating is synchronous, from what the decorator has; the host decorates again after `onChange` (it bumps a generation, so `ReinsHost.decorations(source)` returns a new `MessageDecorations` and messages parse again), and returns the same object otherwise, so rendered messages keep their HTML. The host applies decorators (`components/message-decorations.ts`): the marked token walk for Markdown (never code blocks, HTML, links or images), plain-text segments for user messages, rendering as buttons around the original text, and activation through `workspace.open`. Messages still streaming are not decorated, and the message text, copied Markdown and provider history never see decorations. Where decorators overlap, the earlier registered wins.

## The Changes tab exception

The Inspector's Changes tab (the changed-files tree) is not a registered view: it is the Inspector's own pinned first tab, rendered by `app-workspace` and handed to `workspace-inspector` as `changes`. It needs `DiffStore` and `CodeReviewStore`, which are not SDK capabilities. `{ view: "changes" }` stays a `View` (it can be opened, which focuses it), and `views.register("changes", …)` throws. It becomes a registered view only if diffs and review become capabilities.

## Not built yet

Deliberately left out until there are external extensions:

- **Activation** — loading, ordering, failure state and disposal of extensions; today `app-shell` calls the built-in register functions directly.
- **Namespacing** — view names and decorator identity per extension (`"<plugin>:<name>"`); today `ViewParameters` is a closed interface (exported, so a later package can augment it).
- **A types package** — `contract.ts` is ready to move, but is not published.
- **Versioning** — no compatibility promise; the contract changes with the app.
- **A loader** — no discovery, bundles or manifests ([pinned-plugin-apps.md](../plans/pinned-plugin-apps.md)).
- **Further capabilities** — opening the file browser is still the `open-in-browser` event, not an SDK call; diffs, review, sessions and overlays are not capabilities.
