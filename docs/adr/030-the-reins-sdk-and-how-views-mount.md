# ADR-030: The Reins SDK, and How Views Mount

- **Status:** Accepted
- **Date:** 2026-10-23
- **Author:** Will (with Claude)

## Context

The Reins SDK ([reins-sdk.md](../dev/reins-sdk.md)) is what built-in frontend features use: a source's files, `workspace.open`, and two contribution points, views (such as Inspector tabs) and message decorators (views shown in place of pieces of message text). Later, external extensions will use it too.

Two questions decide its shape:

- **How a feature gets the SDK.** The SDK needs the app's long-lived state: `AppStore.files` (which needs the WebSocket client and the session cache), the registered renderers and decorators, and the Inspector's tabs. `app-shell` creates that state at startup, so it does not exist when modules are imported. External extensions must not have the app's code bundled into them, and may each need an SDK of their own (their namespace, their disposal).
- **How a feature puts its content on the page.** Plugin authors will use React, Svelte, Vue and others. A custom element is awkward for them to make, but every framework can "render into this element, then tear down": React `createRoot`/`unmount`, Svelte and Vue `mount`/`unmount`, Solid `render`. A view in a pane and a view in place of message text are the same thing: content of a feature's own, in a place the app owns.

## Decision

### The SDK is built over the app and given to register functions

**`app-shell` builds the SDK over `AppStore` and gives it to the built-ins' register functions**, as VS Code gives an extension its `activate(context)`.

- **What the SDK needs is app state on `AppStore`**, next to `files`: `views` (a `ViewRegistry`), `decorators` (a `DecoratorRegistry`) and one `inspector`, with `open(view, container)`. App code uses them as it uses any store: the Inspector looks up `views.rendererFor(view)?.pane`, and the workspace shows `app.inspector`. App code never sees the SDK object.
- **`createReinsSdk(app)` (`reins-sdk/sdk.ts`)** builds the frozen SDK object and adds no state. `app-shell` builds one and calls `registerFileView(reins)`, `registerFileReferences(reins)` and `new FileBrowserStore(reins)`. A register function returns a disposer.
- **A view that is about something fixed names it in its parameters.** `file` and `file-reference` carry their `source`, and `viewKey` includes it. A view that follows the viewed session reads its context instead. So `workspace.open(view, { in? })` needs no source, nothing has to find the workspace on screen, and opening works while no workspace is shown.
- **Plugin code imports only `reins-sdk/contract`** (types and pure helpers, a `tsconfig.json` `paths` alias). It gets everything else from its register function. Lint (`reins/features-through-sdk`) rejects any other path into `reins-sdk/` and the app's stores.
- **Later, a loader calls an external extension's register function** with an SDK object of its own, and the extension keeps `reins-sdk/contract` external when it is bundled. That loader is not built.

### A view has one lifecycle, a mount function for each presentation

- **The mount contract.** `mount(target, view, context)` draws into `target`, an element the app made, and returns `{ update?(view, context), dispose?() }`. A new view object given to `update` means "show it afresh" (a view opened again). Without `update`, the app disposes and mounts again. After `dispose`, the app empties the target. The app never mounts a target twice without a dispose between. Plugins never define a custom element; a view's mount gives the element it draws with what it uses (the file view's element gets `files`).
- **Presentations.** A renderer gives a mount for each presentation it supports: `pane` (the Inspector's tabs, and later the main area) with the tab's title, description and icon, and `inline` (in place of a piece of message text). `popover` can be added later as one more key. A container is a place with an identity (`ContainerId`, `"inspector"`) and offers a presentation: the Inspector offers `pane`, and shows a view without one as unavailable.
- **Each presentation has its own context.** A `pane` gets `WorkspaceContext`, the viewed session's source. An `inline` view gets `InlineContext`: that, plus the piece's `text`, whether it was a whole inline-code span (`code`), and `original()`, a new copy of what the app draws without a view (`<code>app.ts</code>`).
- **One element, `<reins-view-mount>` (`ViewMount`), runs the lifecycle wherever a view is shown**: an Inspector tab and a decorated piece. Connected with a presentation, view and context, it mounts into itself. A new view or context updates the view. Disconnected, it disposes. Properties set together apply once. A moved element disposes before it mounts again. The Changes tab is the `diff-file-tree` view, which `app-workspace` registers into `AppStore.views` like any view; its mount reaches the app's diff and review stores because app code may (reins-sdk.md *Views over the app's state*).

### Message decorations are views shown inline

- **Decorators only find ranges and name views.** They have `decorate(text, context) → { start, end, view }[]`, `decorateCode?(code, context) → View | null` and `onChange`. A piece has one view: where decorators overlap, the earlier registered wins, and a view without an inline presentation leaves its text alone.
- **An inline view controls its piece completely.** It may draw the text, change it or draw something else. The app keeps the rest: it does not change the stored message, copied Markdown, provider history or compaction input; the original text stays until the view mounts, comes back when it is disposed, and stays when no renderer shows the view inline; and it decides where decorating may happen (prose and whole inline-code spans, never code blocks, HTML, links, images or a message still streaming).
- **How a view mount inside Markdown gets its view.** Decorated Markdown and user text are HTML strings rendered with `unsafeHTML`, where a template cannot bind properties. The HTML holds `<reins-view-mount data-piece="N">` around the original text. After an update that rendered new HTML, the rendering element (`InlineViews`, for `markdown-content` and `decorated-text`) sets each view mount's `presentation`, `view` and `context` from the piece at index N. The properties stay on the element, so a message that leaves the page and comes back mounts again without being rendered again.

### Rejected

- **A module value, `import { reins } from "reins-sdk"`, with a host installed into it at startup** (a `ReinsHost` that held the registries, bridged `workspace.open` to the workspace on screen and held the files; also its smaller form, a flat app-side `host` object with `provideFiles` and `showWorkspace`). It needed an install step to bind module state to state that exists only after startup, made using `reins` too early an error, needed a test preload to uninstall the host, and sent the app's own state through an object that existed only for that.
- **A global** (`globalThis.reins`): one value for everything on the page, which can never become per-extension.
- **A required `source` on `open`, with one Inspector for each project**: some views have no source, and some views may need to stay when the session changes.
- **The `AppStore` constructor building the SDK, or a module-singleton `AppStore`**: the first connects `AppStore` to the SDK and to each test that makes one; the second opens a WebSocket client when a module is imported.
- **Custom elements as the view contract**: every framework can mount into an element, but making a conforming custom element is extra work for React or Svelte authors, and an element the Inspector creates from a name can only be given `view` and `context`.
- **A mount on decorators only**: views would keep a different lifecycle. An inline view is a view, and the same renderer can show it as a pane or, later, as a popover.
- **The decorator returns HTML for a piece**: a string cannot carry listeners, the app would have to sanitize it, and user messages are not Markdown.
- **Semantic decorations, as on iOS** (`UITextItem`: a label, a primary action, a menu and a preview that the app draws): consistent and accessible, but it limits features to what the app designed. Anything new (a badge, a status) would need an app change.
- **The app keeps the text, and the view only adds around it**: the app would need rules for what a view may touch. A view that wants the default look has `original()`.
- **A view mount that reads its view from a JSON attribute and its context from the nearest message**: views are serializable, but the context is not (`original()`), and finding the nearest message would tie the view mount to message elements.

## Consequences

- Only `app-shell` knows the SDK exists. Other app code knows the app's stores. Startup has no order to get wrong: the SDK does not exist until `app-shell` has what it is built over.
- Tests give plugin code an SDK built over real registries (`testSdk`) and give app code its stores. Nothing global is installed, so nothing is cleared after each test.
- The Inspector is one for the app. As a provisional policy, its closable tabs close when the viewed session's source changes to another. A file tab shows its own source's file.
- File references are the `file-reference` view (`{ source, path, startLine?, endLine? }`), registered with an `inline` presentation beside their decorator. It draws the original text inside a `span` with `role="button"` that opens the file with `workspace.open`.
- The contract's DOM types are elements and nodes that the app gives a feature (`HTMLElement` as the target, `Node` from `original()`). The app never takes markup or templates from a feature.
- An inline view can replace the text, so selecting and copying a message copies what the views drew. Copied Markdown (the copy action) is the stored text. No copy handler fixes up a selection yet.
- This is a boundary between modules, not a security boundary: an extension in the page can still change the DOM.
- Details: [reins-sdk.md](../dev/reins-sdk.md); [frontend-architecture.md](../dev/frontend-architecture.md) *The Reins SDK*, *Views and the Inspector*, *Message decorations*; [workspace-inspector.md](../plans/workspace-inspector.md) *Slice 2d*, *Slice 2e*.
