# Workspace Inspector, Views and Message File References

Status: **in progress**: slices 1 and 2 done (2026-10-20), slice 2b (host APIs and modules) done (2026-10-21), slices 2c (the Reins SDK) and 2d (one view lifecycle) done (2026-10-22), slice 2e and one file viewer done (2026-10-23); slices 3 and 4 remain.

## Goal

Keep things in reach while working in the main area, and make file references in messages open them.

- **The Inspector:** the right-hand area of the workspace becomes a strip of tabs. Each tab shows a view: the changed-files tree, a file, and later whatever plugins provide. A plan document can stay open beside the conversation.
- **Views opened through one call:** `workspace.open(view, { in })` shows a view in a container of the workspace, today the Inspector. Message links, file search, the file browser and tool actions all open files through it.
- **File references in messages:** real project files mentioned in completed messages become controls that open them in the Inspector.

## Views

A view is a plain, serializable object whose `view` field names what it shows; the rest are its parameters:

```ts
type View = { readonly view: string; readonly [parameter: string]: unknown };
// { view: "diff-file-tree" }, { view: "file", source, path, startLine?, endLine?, mode? }
// later, from plugins: { view: "github:pr", number: 412 }

workspace.open(view: View, options?: { in?: "inspector" }): void
```

The SDK names no views: view names are registered at runtime, so code loaded later can add them, and the feature that registers a view defines its parameters' type (`FileView` with the file viewer) and adds it to the SDK's empty `ViewTypes` for TypeScript only.

- **Renderers are registered by `view`** through the Reins SDK (`views.register`, [reins-sdk.md](../dev/reins-sdk.md)). Each value of `view` has one renderer, which gives a mount function for each presentation it supports (ADR-030): `pane` for the Inspector's tabs (with the tab's title, description and icon), `inline` for message text. A popover presentation (hover previews) is meant to come later as one more key. Built-ins register the way a plugin will; plugin views will use a namespaced value (`"<plugin>:<name>"`), which is not built yet. The `diff-file-tree` view (the Changes tab) registers the same way, from app code over the app's stores (reins-sdk.md *Views over the app's state*).
- **Identity:** a view's identity is its `view` plus the parameters that select what it shows (for a file, its source and path; line numbers and the mode only move within it), which its renderer's `key` gives. Opening a view that is already open focuses its tab and replaces its view with the one opened, rather than opening a second tab.
- **A view loads what it shows itself**, through the host's APIs (*Host APIs and modules*, below); no feature store is shared between views or containers. What must survive being opened elsewhere (a file's lines, its Code/Preview choice) travels in the view's parameters.

## Containers

- **The Inspector** (desktop: the resizable right pane; mobile: its swipe page, today's Files page). A strip of tabs: open, focus, close, reorder. The changed-files tree is its first tab, and cannot be closed. The Inspector's tabs are per project and remembered on this device, saved as their `View` objects; a saved view whose renderer no longer exists, or whose file is gone, is dropped or shown as unavailable rather than failing the strip.
- **The file browser is not a container.** It is a module of its own (below), shown as a modal. It shows its file in the same file viewer as an Inspector file tab, whose **Open in Inspector** action asks for a `file` view with the file's path, lines and Code/Preview choice.
- **The main area (reserved, not built):** placing a view in the main area is navigation: a route carries the serialized view, the main area renders it with the same renderer, and Back returns to the conversation. That is how a project dashboard or a pinned plugin app ([pinned-plugin-apps.md](pinned-plugin-apps.md)) would take over the main area. Chat and Changes stay as they are, the default for a session's route. Open: whether this is `workspace.open(view, { in: "main" })` or a separate navigation call, since `open` meaning navigate may confuse.

`in` names a container by ID rather than a closed set. Today the only ID is `"inspector"`. A later layout (user splits, or containers a plugin asks for) adds IDs without changing views or callers. Plugins creating panes, nesting and docking are deferred.

This also ends the double meaning of "files": the changed-files tree is the Inspector's `diff-file-tree` view (the Changes tab), and the project file browser is the file browser.

## Host APIs and modules

Decided 2026-10-21 (slice 2b), then put behind one host API, the Reins SDK, on 2026-10-22 (slice 2c; [reins-sdk.md](../dev/reins-sdk.md)). The host offers capabilities and contribution points; built-in features consume them, own their own state, and get them only from the SDK, which `app-shell` builds over `AppStore` and gives to their register functions (slice 2e, ADR-030). A feature that wants state shared between several of its extensions (a plugin with a view and a decorator over one cache) keeps it inside its own package; that is the plugin case and is not designed here.

- **`files`** (the project files API, `ProjectFiles`, application lifetime on `AppStore`): for a source (`{ nodeId, path }`; since ADR-029 where its files are read) it gives the file listing synchronously, cached for the two sources asked for last with generation checks, so a superseded response cannot land; it reads a file's content (uncached); and it says when a source's files may have changed, inferred from the session events that change files (the end of a file-modifying tool, the end of a turn) and mapped to the session's source through its placement, marking that source's listing stale so the next ask reloads it. The host works out how to reach a source and whether its node is connected from the sessions placed on it: today through their project's file routes (which read the project's default source); a route that reads a source by node and path changes only it. No listing while the source's node is offline.
- **`workspace.open(view, { in? })`**: `AppStore.open` opens it in the app's Inspector; a view about a source names it. On a phone the workspace on screen moves to the Inspector page.
- **`views.register`** and **`messages.registerDecorator`**: the contribution points (*Views*, *Markdown decoration*).
- **The file browser** is a feature of its own (`FileBrowserStore`), created and mounted by the application shell, unconnected to the workspace: it is opened for a source and optionally a path, lines and Code/Preview choice (from the workspace, a tool result, the server's `open_file`), owns its store (directory tree, the open file, its search's query), reads the listing and content through `files`, and refreshes on its change signal. Opening and closing it does not reset it; another source starts it over. File search is part of it. **Open in Inspector** calls `workspace.open` with its source.
- **The file viewer** (`registerFileViewer`) is the `file` view's pane, and the file browser shows one too (*The file viewer*, below): one file, with a loader of its own, through `files`, read again for every new view object (each open) and when the files API says the source's files changed.
- **File references** (`registerFileReferences`) are a message decorator, resolving against the listing from `files`.

## Automatic message references

Completed messages are scanned for plausible file references in both ordinary prose and inline code. A reference becomes interactive only when it resolves to a real file in the viewed source.

Examples:

```text
packages/frontend/src/components/chat-message.ts
README.md
chat-message.ts:127
packages/frontend/src/components/app.ts#L120-L135
/home/will/Workspaces/reins/docs/TODO.md
```

Resolution rules for the first version:

- normalize absolute paths contained within the source's checkout to project-relative paths
- reject absolute paths outside the checkout and references containing traversal
- recognize optional line and line-range suffixes
- prefer the longest valid match when candidates overlap
- resolve full relative paths exactly
- resolve a bare basename only when it is unique in the inventory
- preserve surrounding punctuation
- do not decorate URLs, existing Markdown links, images, or fenced code blocks
- do not decorate while a message is streaming
- leave unresolved or ambiguous text unchanged

Activating a reference calls `workspace.open({ view: "file", path, startLine, endLine }, { in: "inspector", source })`. On mobile that also moves to the Inspector page.

### Inventory and freshness

Reuse the project file listing (from the files API) rather than a second source of filesystem truth, and build an index from it for exact full-path lookup, unique-basename lookup and longest-match candidates. Do not compare every path against every text node.

Refresh the index when the files API says the source's files may have changed (a file-modifying tool or a turn ended), so files created during the turn can be cited. Conversations that render before the inventory is ready render normally first and gain file controls when it arrives; cache resolution per inventory generation. When the source's node is offline, there is no inventory and nothing is decorated.

### Markdown decoration

Decoration is a presentation transform. It must not modify persisted message text, provider history, copied message Markdown or compaction input. Apply it through Markdown tokens or rendered text nodes, not a regular expression over generated HTML; existing anchors and code blocks keep their semantics. User and assistant messages are decorated alike.

## Implementation slices

1. **(done)** **The Inspector with files.** The `View` type and renderer lookup with two views (`changes`, `file`); `workspace.open` with `"inspector"`; the Inspector's tab strip on desktop and its swipe page on mobile (open, focus an existing tab, close; the changes tab first and not closable); the `file` view rendering the existing viewer from a per-project file model that survives switching tabs and sessions; **Open in Inspector** from the file browser modal and file search. Not yet: remembered tabs, reordering, the modal as a `workspace.open` container, message references.
2. **(done)** **Message file references:** the reference index, path and line-range parsing, decoration of completed Markdown, opening in the Inspector.
2b. **(done)** **Host APIs and modules** (*Host APIs and modules*, above): the project files API; the file browser and file search as their own module, mounted by the application shell again; Inspector file views loading their own file; message decorators with file references as the first; `FileModel` removed. Behavior as built in slices 1 and 2, except that Open in Inspector carries the Code/Preview choice.
2c. **(done)** **The Reins SDK** ([reins-sdk.md](../dev/reins-sdk.md)): one host API through which the built-in features (the file view, file references, the file browser) get `files` and `workspace.open` and register views and message decorators, imported from the `reins-sdk` module specifier; the `open-view` event, the renderer table and the decorator table removed. Behavior as in slice 2b, except that opening an open file replaces its view (*Slice 2c*).
2d. **(done)** **One view lifecycle** (ADR-030): views are mount functions per presentation (`pane`, `inline`), run by one host element (`<reins-view-host>`) in Inspector tabs and messages; decorators only find ranges and name views, and file references are the inline `file-reference` view. Behavior as in slice 2c, except that a file reference is selectable text with the role of a button, not a `<button>`.
2e. **(done)** **The SDK as an adapter over `AppStore`** (ADR-030): *Slice 2e*, below. A view about a source carries it, and there is one Inspector for the app.
3. **Tabs that last:** tabs remembered per project on this device (with unavailable views handled), and reordering.
4. **The main area** when the first dashboard or pinned app needs it.

To do (not scheduled):

- [ ] **Mobile: the diff review as the Inspector's Changes tab.** On a phone the Changes page (the diff) and the Inspector's Changes tab (the changed-files tree) say the same thing, and the tree only jumps back to the diff. Instead: three pages (Sessions → Chat → Inspector), the Inspector's Changes tab showing the diff review with the changed files as a jump list inside it, and the toolbar's Changes button focusing that tab. Desktop is unchanged. Move the existing review section into the Inspector's page with grid placement rather than rendering a second one, so a resize never remounts it (it is virtualized and holds the inline review composer). Not the main area: nothing is routed; it is a first, mobile-only step toward Changes as a view.
- [x] **Mobile: swiping goes through the Inspector's tabs** (done, 2026-10-21). Each tab is a mobile page after Changes: swiping left from Changes reaches the first tab, further swipes the next ones, and right from the first tab returns to Changes. The workspace surface stops at the Inspector's column and the rest of the drag moves a track of the tabs' panels (laid side by side on phones, stacked at `md`), so the strip stays in place while content slides. Content that scrolls sideways (a file with long unwrapped lines) still keeps horizontal drags, so such a file swipes from its header; an overflowing strip scrolls rather than swipes. With the item above done, the diff becomes the first of those pages without further swipe work.

## Progress and decisions

Slices 1 and 2 were built on a per-project `FileModel` owned by `WorkspaceStore`, with the file browser and file search moved into `app-workspace`. Slice 2b replaced that (*Host APIs and modules*); the decisions in slices 1 and 2 that concern `FileModel`, the file browser living in the workspace, and slice 3 moving view state through the file model are superseded by it. Slice 2c then put the host's capabilities behind the Reins SDK; where slices 1, 2 and 2b name `open-view`, the renderer and decorator tables, `FileSource` or tab revisions, slice 2c's decisions replace them. Slice 2d replaces how views and decorations render (the views' custom elements, the `<button>`, its `data-view`, `parseView`, `label`). Slice 2e replaces the SDK's access and the host: where slices 2c and 2d name `ReinsHost`, `installHost`, `import { reins } from "reins-sdk"`, `mountWorkspace`, `<reins-view-host>`, an `open` that names a source, or one Inspector per project, slice 2e's decisions replace them. *The file viewer* renames what earlier sections call the file view (`inspector-file-view`, `registerFileView`, `components/file-view/`) and the presentational `file-viewer`. The Inspector's element, `workspace-inspector` in `components/inspector/` in earlier sections, is now `app-inspector` (`components/app-inspector.ts`, `AppInspector`), like `app-workspace`: it was the folder's only component. *Views named at runtime* replaces `ViewParameters`, `ViewOf` and `viewKey` wherever earlier sections name them. *The SDK's name and folders* replaces `reins-sdk/contract` (and "the contract") with `@reins/sdk`, and the SDK's modules in `reins-sdk/` (`sdk.ts`, `view-registry.ts`, `decorators.ts`) with `sdk-host/`, wherever earlier sections name them.

### The SDK's name and folders (done, 2026-10-24)

"Contract" said what the module was in code (types only, importing nothing), not what it is: the SDK features develop against. The `reins-sdk/` folder also held the app's side of it, which features must not import.

- **Features import `@reins/sdk`** (a `tsconfig.json` `paths` alias to `reins-sdk/index.ts`, was `reins-sdk/contract` and `contract.ts`). It is the name a package of its own would have. "SDK", not "API": the word alone suggests a network API.
- **`reins-sdk/` holds only the SDK.** The app's side moved to `sdk-host/`: `create-sdk.ts` (`createReinsSdk`, was `sdk.ts`), `view-registry.ts`, `decorators.ts`.
- **The SDK imports only its own modules** (`./`; lint `reins/sdk-isolation`, was `reins/sdk-contract-isolation`, which allowed no import). Code that runs, such as event emitters features listen to, is expected to join the types there. `reins/features-through-sdk` rejects paths into `reins-sdk/` and `sdk-host/`.

### Views named at runtime (done, 2026-10-24)

The contract listed every view's parameters (`ViewParameters`, with `ViewName`, `ViewOf`, `ViewRendererMap`, `FileViewerMode`) and computed every view's identity (`viewKey`). That fixed the set of views at compile time, but views are registered at runtime so that code loaded later can add its own.

- **`View` is any plain object with a `view` name** (`{ readonly view: string; readonly [parameter: string]: unknown }`). The contract names no view.
- **A feature defines its view's type** and adds it to `ViewTypes`, an empty interface in the SDK, by declaration merging beside its register function. `FileView` and `FileViewerMode` are in `components/file-viewer/file-viewer.ts`, `FileReferenceView` in the file references extension, `DiffFileTreeView` with the diff file tree. `views.register(name, …)` types the renderer from the name, and `workspace.open` and decorators' views take a `KnownView`, so file references opening a wrong `{ view: "file", … }` fails typecheck.
- **Types only.** Nothing at runtime reads `ViewTypes`: any name registers and opens, so an extension without TypeScript works the same (a plain JavaScript extension in the SDK's tests). A typed extension sees another's views only if it has that extension's types.
- **The renderer gives the identity:** `ViewRenderer.key?(view)` says what tells views of its name apart (the file viewer: source and path); without it a name has one view. `ViewRegistry.keyOf(view)` is the name and that key, and the Inspector is built over it (`new Inspector(views)`). A view without a renderer is keyed by its name until one is registered; remembered tabs (slice 3) will need to key restored views again once their renderers come.

### The file viewer (done, 2026-10-23)

"File viewer", "file view" and "file browser" named three things: the presentational component that shows a file's content, the `file` view's element in an Inspector tab (a header and a loader around that component), and the modal with the tree and search. The names did not say which was which. Now there are two:

- **The file viewer** (`components/file-viewer/file-viewer.ts`, `<file-viewer>`, `FileViewer`, `registerFileViewer`) is one file: its header (path, download, the action to open it in the other container) over `file-viewer-content` (the old presentational component, which picks the renderers and shows the Code/Preview tabs). It is the `file` view's pane, and the file browser shows one too. "The `file` view" stays as the SDK's name for the view, in code font only.
- **The file browser** is the modal: tree, search and a file viewer. It renders `<file-viewer>` itself, not through the view registry, as both are file code.

Decisions:

- **The viewer offers to open its file in the other container** (`container`: `"inspector"` or `"file-browser"`): from an Inspector tab, *Open in file browser* (`open-in-browser`); from the browser, *Open in Inspector* (`open-in-inspector`, which `FileBrowserStore.openInInspector(view)` handles: it opens the view and closes the browser). Both carry the lines and the Code/Preview tab the user is on (`shown`).
- **`FileBrowserStore` keeps a `file` view, not a file.** `view` is a new object for each open with a path, which its viewer reads again and reveals the lines of; an open without a path keeps it. The store's `FileLoader`, `lines`, `mode`, `setMode` and `contentUrl` went.
- **The browser stays rendered, hidden, while closed** once it has shown a file, so opening it again shows the file and its scroll position without reading it again.
- **The Code/Preview choice is a "mode"** everywhere: `FileViewerMode`, `file-viewer-content`'s `initialMode`, `file-viewer-mode-change`.
- **Behavior changes:** an Inspector tab's folder button carries the tab the user is on, not the one the tab was opened with; an Inspector file tab has a download button; the browser's top bar shows the checkout's name, and the file's path and actions are in the viewer's header below it.
- **Considered and dropped:** keeping three components with clearer names ("file pane" for the `file` view's element, "file display" for the presentational one). "Pane" is wrong inside the browser's modal, and with the browser showing the viewer there is nothing left for the third name.

### Slice 2e: the SDK as an adapter over `AppStore` (done, 2026-10-23)

`ReinsHost` did three jobs in one class: it was the registry of views and decorators, the bridge from `workspace.open` to the workspace on screen, and the holder of the files. On top of it were `installHost` and a proxy `reins` that read the installed host on each use. The host went down through the router to `app-workspace`, which gave it to the Inspector (`.renderers`) and to the chat panel as decorations. App code had to know about a coordinator object.

Two things caused this:
- `reins` was a module-level value. Slice 2c made it one because the Inspector created a view's custom element and could give it only `view` and `context`. Slice 2d removed that reason: a view is a `mount` function that creates its own element, so it can get the SDK as an argument.
- The source was given to the open call (`open(view, { source })`). So something had to find the project and the workspace on screen.

The decision:

- **A view that is about a source carries it in its parameters**: `file: { source, path, startLine?, endLine?, mode? }`, and the same for `file-reference`. `viewKey` includes the source. The file view reads from `view.source`. A view that follows the viewed session (the diff file tree) uses the context (`WorkspaceContext`). A view about nothing in particular (a dashboard, a pinned app) has neither. `open` takes no source: `workspace.open(view, { in? })`.
- **The registries and the Inspector are app state on `AppStore`**, next to `files`: `views` (a `ViewRegistry`: `register`, `rendererFor`, `subscribe`), `decorators`, and one `inspector` (the tabs, which tell listeners when a view opens). `AppStore.open(view, container)` opens the view in the container. App code uses them as it uses any store. The Inspector gets `.views` from `app-workspace`, with the tabs, calls `views.rendererFor(view)?.pane` and subscribes to the registry itself.
- **The SDK is an adapter that `app-shell` builds**: `createReinsSdk(app)` in `reins-sdk/`, so that `AppStore` does not know about the SDK. `app-shell` gives it to the built-ins' register functions (`registerFileView(reins)`, `registerFileReferences(reins)`, `new FileBrowserStore(reins)`), which return disposers. They become each area's `activate(reins)` when the code is grouped by area (*Next*). There is no install step, no provide step, no "used before" error, no `ReinsHost`, no `host` object and no `reins` module value.
- **Plugin code gets `reins` as an argument.** `FileBrowserStore`, `FileReferences` and `FileLoader` get `files` from it. The file view's `mount` sets `files` on its element. File references call `reins.workspace.open` from their closure. Later, a loader calls `activate` with an SDK object for each extension.
- **App code registers into the app state directly.** `app-workspace` registers the diff file tree into `app.views`, over its workspace's stores.
- **The workspace keeps only UI work.** It shows `app.inspector`. On a phone, it moves to the Inspector page when its Inspector says that a view opened. `mountWorkspace`, the `.host` property (router, `app-workspace`) and the Inspector's `.renderers` property go.
- **Tabs (provisional):** the Inspector closes its tabs, except the Changes tab, when the viewed session's source changes to another (`Inspector.setViewedSource`, which `WorkspaceStore` calls; the first source known and null close nothing). We will decide the final policy after we use it: clear on each session change, clear on a source change, or keep all.
- **The boundary.** Plugin code imports only `reins-sdk/contract` (types and pure helpers such as `sameSource` and `viewKey`), never another `reins-sdk/` path or the app's stores (lint: `reins/features-through-sdk`). It gets everything else from `activate`. This is a boundary between modules, not a security boundary: a plugin in the page can still change the DOM.
- **`<reins-view-host>` becomes `<reins-view-mount>`** (`ViewMount`), because nothing else is a "host" now.
- **Tests** give plugin code an SDK built over real registries (`testSdk`), and give app code an `AppStore` or its parts. Nothing global needs to be cleared after each test (`installTestHost`, the test preload and `bunfig.toml` went).
- **Behavior changes:**
  - The Inspector is one for the app, not one for each project. Its tabs are cleared when the source changes (above).
  - A file tab continues to show its own checkout's file. Before, it read the same path from the new checkout when you changed to a session on another checkout.
  - An open while no workspace is on screen (settings) opens the tab. You see it when you go back.
- **Considered and dropped:**
  - `reins-sdk` as a module value with a host behind it (slice 2c, and the first form of this slice): `installHost`, then `host.provideFiles(appStore.files)`, a flat app-side `host` object (`showWorkspace`, `rendererFor`, …). All of it existed only because `reins` was bound at import time to app state that exists only after startup.
  - A required `source` on `open`, with one Inspector for each project kept on `AppStore`: some views have no source, and we may want some views to stay when the session changes.
  - The `AppStore` constructor building the SDK, or a module-singleton `AppStore`: the first connects `AppStore` to the SDK, and the second opens a WebSocket client when a module is imported.
- **Recorded in** ADR-030, rewritten for this slice before the branch was merged, with what was ADR-031 (one view lifecycle) folded into it; reins-sdk.md, frontend-architecture.md and workspace-panes.md describe the result.
- **Next, separately:** group the code by area (`files/`, `changes/`), with one `activate` for each area and one list that `app-shell` calls. The word "features" goes away.
- **A view draws its tab's icon** (decided 2026-10-23): `PanePresentation.icon` is a presentation (`mount` into a 14 px box the app gives, in `currentColor`), given at registration, not a name from `IconName`, which went with the Inspector's table of icons. The built-ins draw theirs from `ui/icons.ts` with `paneIcon`.
- **Message decorations stay generic** (decided 2026-10-23): decorators and inline views stay, rather than file linking becoming a fixed part of message rendering. What applied them in `components/message-decorations.ts`, which was not a component, is now `models/decorated-html.ts` (decorated Markdown and plain text as HTML) and `controllers/inline-views-controller.ts` (`InlineViewsController`, was `InlineViews`).
- **Decorators, not decorations, go to messages** (decided 2026-10-23): what goes down is the registered decorators, so it is named for them: `MessageDecorations` is `BoundDecorators` (`reins-sdk/decorators.ts`, was `decorations.ts`), `DecoratorRegistry.decorations(source)` is `bind(source)` (it fills in the context every decorator gets, so it is a binding, not a filter, which `forSource` suggested), and the `decorations` properties are `decorators`; decorations are only what they find. `app-workspace` gives `chat-panel` the registry, and `chat-panel` subscribes and makes the `BoundDecorators` for its messages, so `app-workspace` no longer subscribes. Every decorator applies to every source; the source is what they decorate for.

### Slice 2d: one view lifecycle (done, 2026-10-22)

Views were custom elements the Inspector created, and decorators (first drawn by the host as `<button>`s, then given each piece's wrapper to `mount`) had a lifecycle of their own. Now a view is a mount function for each way it can be shown, and decorations are views shown inline. ADR-030 records the decision and the options rejected (custom elements as the plugin-facing contract, a mount on decorators only, returned HTML, iOS-style semantic decorations, the host keeping the text); reins-sdk.md *Contribution points* the contract, and frontend-architecture.md *Views and the Inspector* and *Message decorations* the code.

- **The mount contract.** `mount(target, view, context) → { update?, dispose? }`, which any framework can satisfy (React, Svelte, Vue, Solid). A new view object in `update` shows it afresh; a view without `update` is mounted again; the host empties the target after `dispose`.
- **Presentations:** `pane` (the Inspector's tabs; title, description and icon live here) with `WorkspaceContext`, and `inline` with `InlineContext` (`text`, `code`, `original()`). A container offers a presentation; the Inspector offers `pane`. **Popovers are a later presentation** (hover previews of a file reference): one more key on the renderer, with a context of its own; not built.
- **`<reins-view-host>` (`ViewHost`)** runs the lifecycle in Inspector tabs and decorated pieces; the Inspector no longer creates elements from a name. It disposes when it leaves the page and mounts again when it comes back, never twice without a dispose between.
- **In Markdown**, decorated pieces render as `<reins-view-host data-piece="N">` around their original text inside `unsafeHTML`; `InlineViews` sets each one's presentation, view and context after the render (a JSON attribute was not taken: the context is not serializable). The text stays until the view mounts and when no renderer shows the view inline.
- **Decorators** return `{ start, end, view }` spans and `decorateCode` a view; they have no `mount`. Where they overlap, the earlier registered wins.
- **File references** are the `file-reference` view, registered by the file-references feature with an inline presentation that draws the original text as the control. **The file view**'s pane mount creates its element. Behavior is unchanged.
- **Removed:** `ViewElement`, `ViewRenderer.element`, decoration values and decorators' `mount`, `DecorationMounts` (and its `keyed` re-render).

### The Changes tab as the diff-file-tree view (done, 2026-10-22)

The Inspector no longer hardcodes the Changes tab (its `changes` property and its checks for `view.view === "changes"` are gone). The tab is the `diff-file-tree` view (renamed from `changes`; it is still titled Changes), registered with `views.register` and shown through `<reins-view-host>` like every view (reins-sdk.md *Views over the app's state*).

- **Registered by app code over the app's stores.** `app-workspace` registers it while connected (`registerDiffFileTree`), and its `pane` mount creates `<diff-file-tree>` over `DiffStore`, `CodeReviewStore` and `FileTreeState`. Its only privilege is that app code may use the stores; nothing in the SDK, the registry or the Inspector tells it apart, and `views.register` no longer refuses its name. A new `WorkspaceStore` registers it again.
- **The active file moved into `DiffStore`** (`activeFile`, `setActiveFile`, cleared when the project changes), so the mounted tree follows it by its store subscription, as it follows the diff and the review.
- **Considered and dropped:**
  - A `workspace.changes` SDK capability (the changed files with their counts and review comments, the mode, the active file, `setMode`, `reveal`), so a feature could register the view. It put the current diff review's shape into the contract, would grow with the tree, and could never carry the mobile to-do's full diff review.
  - Host views: the workspace handing the Inspector a `render()` per host view name on every render, with `views.register` refusing those names. It worked, but the Inspector told two kinds of tab apart; with ADR-030's mount lifecycle the view can register like any other.
  - Giving host-registered views the `WorkspaceStore` as a privileged property set by the Inspector: the Inspector would again know about the workspace's stores.
- Behavior is unchanged.

### Slice 2c: the Reins SDK (done, 2026-10-22)

The branch was reworked onto a host API object, as the first frontend seam at extension-architecture.md's Reins-owned stage. reins-sdk.md describes it; frontend-architecture.md (*The Reins SDK*, *Views and the Inspector*, *Message decorations*) the code.

- **Access: an importable module, VS Code-style** (decided 2026-10-22 after the SDK was first built handed to register functions; replaced by slice 2e). Features `import { reins } from "reins-sdk"` and their types from `reins-sdk/contract` (`tsconfig.json` `paths` aliases, which `tsc`, `bun build` and `bun test` resolve to `reins-sdk/index.ts` and `contract.ts`), so for built-ins the specifier is the page's one instance through an ordinary import. `app-shell` creates the `ReinsHost` over `AppStore.files` and installs it when it connects (`installHost`), before it registers the features or any element using `reins` connects; using `reins` before that throws, and so does installing a second host. Register functions take no argument. Per-call injection was dropped because it fought the page-global custom element registry: the file view had to define its element as a subclass capturing the first SDK's `files`; now the element is an ordinary `@customElement` reading `reins.files`. `registerFileBrowser` went (it only built a store): `app-shell` creates `FileBrowserStore`, which reads `reins`. Not a global: a global could never become per-extension; later, an external extension keeps the specifier external and a loader resolves it, possibly per extension (deferred). The contract imports nothing; features import the SDK only through `reins-sdk`, never `reins-sdk/` by path or the app's stores (lint: `reins/sdk-contract-isolation`, `reins/features-through-sdk`). Tests install a host with `installTestHost`, which the frontend's test preload uninstalls after every test.
- **Sources are `{ nodeId, path }`.** `ProjectFiles` finds a source's route (the project of the sessions placed on it) and availability itself, from `SessionCache`, and tells listeners when a source's node goes offline or comes back (reloading it then). `FileSource`, with its `projectId` and `available`, is gone. `SessionCache` now notices a placement whose path alone changed.
- **`workspace.open` replaces `open-view`.** `app-workspace` mounts itself into the host while connected. A caller outside the workspace names the view's source; the host resolves its project, and the workspace ignores a view of another project, as before.
- **Views register** a title, description, named icon (`IconName`) and custom element name; the Inspector creates the element and sets `view` and `context` (`{ source }`). The file view moved to `components/file-view/`; its element reads the SDK's `files` (*Access*).
- **The Changes tab stays the Inspector's own pinned tab**: it needs the diff and code review stores, which are not SDK capabilities. `app-workspace` renders its tree and hands it to the strip. (Since registered like any view: *The Changes tab as the diff-file-tree view*, above.)
- **Decorators register** with `decorate(text, context)`, an optional `decorateCode`, and `onChange`; the host applies them (`reins-sdk/decorations.ts`, and the marked token walk, rendering and activation in `components/message-decorations.ts`, out of `markdown-content`). `ReinsHost.decorations(source)` returns the same object until a decorator changes or the source does. File references report a change only when the decorated source's listing array changes. Labels replace titles (`label`).
- **Tabs are simpler.** `View`, `viewKey` and `parseView` moved into the contract. An open replaces the tab's view: no `revision` counter, and no keeping the old lines or mode when an open names none (an open without lines shows no new highlight; one without a mode shows Code). A new view object is what makes a file tab read its file again and reveal its lines; `HighlightRequest` lost its `id` and applies once per object, and the file browser's `lines` (a new object per open) is its request.
- **Deferred:** activation, namespacing, a types package, versioning and a loader (with it, resolving `reins-sdk` per extension); opening the file browser through the SDK (it is still the `open-in-browser` event).

### Slice 2b: host APIs and modules (done, 2026-10-21)

Built as planned; frontend-architecture.md (*Store map*, *Views and the Inspector*, *Message decorations*) describes it.

- **`ProjectFiles` (`AppStore.files`)** is the files API: `listing(source)` (a `Loadable`), `subscribe`, `onFilesChanged(listener)`, `read(source, path)`, `listDirectory(source, path)`, `contentUrl(source, path)`. A `FileSource` is `{nodeId, path, available, projectId}`: node and path are its identity (listings are cached and generation-checked per source), `available` gates listing (idle while the node is offline), and `projectId` only routes the request through today's project file routes, to go once a route reads a source by node and path.
- **The change signal is per source.** A file-modifying tool (`write`, `edit`, `bash`) or `agent_end` of any session is mapped to its source through `SessionCache` placements (nothing for a session whose placement is unknown) and announced 500 ms after the first such event, so a burst of tool calls refreshes once. The API marks that source's listing stale and tells its listeners, and the next ask reloads it (a listing nobody shows is not reloaded); the file browser, Inspector file views and the workspace's diff refresh follow the same signal. This is broader than before: any session in the viewed source changes files now, not only the viewed session's turn end, and every file-modifying tool, not only the turn's end. A refreshed listing that comes back unchanged keeps its `data` array, so decorations built from it are kept and messages are not parsed again.
- **Listings load on demand:** the first `listing(source)` while the node is connected loads it (the workspace asks for it for message decorations as soon as the session's source is known; file search when it opens), and a node that comes back makes the next ask load it again. Only the two sources asked for last keep their listing (the viewed session's and the file browser's), so switching projects drops the old one.
- **`FileLoader` (`models/file-loader.ts`)** is the small loader both the file browser (its open file) and each Inspector file view own an instance of: `show(source, path, {reload})`, read again on reload and on the change signal for its source, the old content kept shown meanwhile, responses for a file or source no longer shown dropped. It keeps the viewer's `FileContent` shape.
- **The file browser module** is `components/file-browser/` (`file-browser`, `file-tree`, `file-search`) over `FileBrowserStore`, owned and mounted by `app-shell`. `open-in-browser`, `open-file-browser` and `open-file-search` carry the viewed session's `source` (tool results get it through `ToolRenderContext.source`, which replaces `projectId`/`checkoutPath`; the diff's view button, the toolbar and ⌘/Ctrl+P from the workspace; `open_file` from `WorkspaceStore`). Inside the module components call the store; `file-browser-close`/`file-search-close` are gone. Opening without a path keeps the last file; the search's query starts empty each time it opens, as before.
- **`open-view` from outside the workspace** names its project (`openViewEvent(view, options, projectId)`); `app-workspace` listens on itself and on the document, ignores a view of another project, and stops the event once handled.
- **Code/Preview travels in the view:** the `file` view has `mode?: "code" | "preview"`; an open without a mode keeps the tab's, as an open without lines keeps its lines. `file-viewer` reports the user's tab choice (`file-view-mode-change`), which the file browser keeps and **Open in Inspector** carries (only `preview`; Code is the default). An Inspector file tab's folder button opens the file browser with its lines and mode too. A tab whose mode is unchanged by a new open does not switch back to it if the user changed tabs inside the viewer.
- **Decorations carry their view:** a decoration renders as `<button class="message-decoration" data-view="…">` with the view as JSON, read back on click through `parseView`; the lookup is `messageDecorations({files, source})` in `models/message-decorations.ts`, returning the same object while its decorators are unchanged.

### Slice 1: the Inspector with files (done, 2026-10-20)

Built as planned: `View`, `viewKey` and `Inspector` in `models/inspector.ts`; the renderer lookup in `components/inspector/views.ts`; `WorkspaceStore.open(view, { in })`, reached from components by the `open-view` event; `FileModel` (`models/stores/file-model.ts`) replacing `FileBrowserStore`. frontend-architecture.md *Views and the Inspector* describes it.

- **Tabs per project, in memory.** `WorkspaceStore` keeps an `Inspector` per project for the page's lifetime, so returning to a project shows its tabs (their files read again). Saving them is slice 3.
- **Closing a tab focuses the tab before it**; a middle click closes too.
- **An open without lines keeps the tab's lines**; an open with lines replaces them and highlights and scrolls again even when they are the same (each open bumps the tab's `revision`, and highlights are requests applied once by ID).
- **Hidden tabs stay rendered**, so a file keeps its scroll position and Code/Preview tab while another tab is shown. The reading position therefore lives in the DOM, not the file model, for now; slice 3 (moving a view between containers) is when it must move into the model.
- **The file browser and file search moved from `app-shell` into `app-workspace`**, which renders them from its `FileModel` as state it owns (`FileBrowserRequest`, `fileSearchOpen`) instead of driving them through queried elements. Every way to open them was already inside the workspace.
- **The file model loads the listing as soon as it has a source** (file search, and slice 2's references, read it), and only while the source's node is connected. An explicit open (the file browser, a tab opened again) reads the file again while the old content stays shown; switching tabs reads nothing; the end of an agent turn reloads the listing, listed directories and loaded files.
- **Scoped to the viewed session's source, read from the default one.** The model's scope is the session's project, node and checkout path, so another source starts it over. The file routes still read the project's default source (node-contract.md *Which checkout a call works in*); making them read the session's checkout is separate server work, after which only the model's requests change.
- **The right pane got wider:** its default width is 320 px (was 240) and it can grow to 960 px (was 400), still leaving the center its minimum. Later the width became per view name: a pane presentation asks for a `width` (Changes 240, `file` 640) and the user's resize is kept for that name, so a file can be wide while the tree stays narrow. The old single saved width is not carried over.
- **The tab strip matches the center toolbar:** rounded tabs within the 50 px row, the active one raised like the toolbar's branch pill rather than square editor tabs joined to the content, since the content below starts with its own header rows. The current tab scrolls into view (on open and on resize), a mouse wheel scrolls the strip, the × shows on the current and hovered tab (always on touch), and a cut-short name keeps its extension. A file tab's header shows the directory muted and left-truncated, the file name in full.
- **Open in Inspector from file search** is ⌘/Ctrl+Enter (a new `palette-alternate-confirm` event of `search-palette`) or an Inspector button on each result row (`renderItemAction`), for touch.

### Slice 2: message file references (done, 2026-10-20)

Built as planned: `FileReferenceIndex` (now `extensions/message-file-references/message-file-references.ts`), `FileModel.references`, Markdown decoration through marked tokens in `components/markdown-content.ts`, and plain-text segments for user messages. frontend-architecture.md *Message file references* describes it; workspace-panes.md *File references in messages* is the user's view.

- **Exactly the files the listing has.** Full relative paths (a leading `./` allowed) and absolute paths under the checkout resolve exactly; a bare basename resolves when unique; a partial path (`components/app.ts`) does not resolve, even when it would be unique. Gitignored files (not in the listing) are never linked.
- **Line suffixes:** `:12`, `:12-20`, `:12:5` (the column is dropped), `#L12`, `#L12-L20`. A single line opens with `startLine` only; a reversed range is put in order.
- **Words, then trimming.** Prose is split at whitespace; a word is a candidate only if it has a `.` or `/` and no `://`. Opening brackets, quotes, backticks and `*` are trimmed from its start, and sentence punctuation, closing brackets, quotes, backticks and `*` from its end, trying the longest candidate first, so `(README.md:4),` links `README.md:4`. An underscore is never trimmed (`__init__.py`).
- **Inline code** is decorated when its whole text is a reference, the code styling kept inside the control.
- **A lone name only in inline code.** In prose a reference needs a `/` or a line suffix: a name with neither (`README.md`, `app.ts`) is linked only as inline code. Agents put a file named by itself in backticks, and in prose such names were often ordinary words that matched a file.
- **Controls are buttons** (`<button class="file-reference">`), not anchors, so no URL or hash changes; they are styled as the text underlined with dots.
- **User messages** are plain text, so they are decorated by `segments()` directly (fenced regions skipped), not through Markdown.
- **Refresh:** the listing (and with it the index) reloads when the viewed session's agent turn ends (`agent_end`) and through `FileModel.refresh()`; there is no other explicit refresh control in the UI yet.
- **Which checkout:** references resolve against the session's checkout path, but the listing comes from the project's default source until the file routes read the session's checkout (slice 1's note). For a session on another node the two can disagree.

## Verification

Cover at least:

- `workspace.open` opens a tab, focuses an existing one for the same file and replaces its view (new lines and mode)
- closing tabs and reordering; the changes tab cannot be closed
- tabs restored per project after reload; unknown views and missing files handled
- Open in Inspector from the file browser carries the file's lines and Code/Preview choice
- the file browser, Inspector file tabs and message references stay fresh after the agent changes files, without sharing a store
- session changes within one project preserve file state; project or source changes reset it and ignore stale responses
- full relative and contained absolute paths resolve; unique basenames resolve and ambiguous ones do not
- line and line-range suffixes become view parameters; surrounding punctuation is excluded
- URLs, traversal, fenced code, existing links and missing files remain unchanged
- completed messages gain controls when an asynchronously loaded index arrives; streaming messages are not decorated
- copied message Markdown remains the original text
- mobile: activating a reference moves to the Inspector page

## Deferred

- views in the main area (Chat and Changes as views)
- splits, drag-to-dock, several tab strips
- syncing open tabs across devices
- how plugins are loaded and activated, and their views and decorators namespaced (the plugin work; built-ins already register through the SDK)
- browser-addressable file routes or a URL scheme for files
- popovers: a `popover` presentation for views (a file reference's hover preview), and a copy handler for selections that cross inline views
- editing files
