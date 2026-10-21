# Workspace Inspector, Views and Message File References

Status: **in progress**: slices 1 and 2 done (2026-10-20); slice 2b (host APIs and modules) next on this branch; slices 3 and 4 remain.

## Goal

Keep things in reach while working in the main area, and make file references in messages open them.

- **The Inspector:** the right-hand area of the workspace becomes a strip of tabs. Each tab shows a view: the changed-files tree, a file, and later whatever plugins provide. A plan document can stay open beside the conversation.
- **Views opened through one call:** `workspace.open(view, { in })` shows a view in a container of the workspace, today the Inspector. Message links, file search, the file browser and tool actions all open files through it.
- **File references in messages:** real project files mentioned in completed messages become controls that open them in the Inspector.

## Views

A view is a plain, serializable object whose `view` field names what it shows; the rest are its parameters:

```ts
type View =
  | { view: "changes" }
  | { view: "file"; path: string; startLine?: number; endLine?: number };
// later, from plugins: { view: "github:pr", number: 412 }

workspace.open(view: View, options?: { in?: "inspector" }): void
```

- **Renderers are looked up by `view`.** Each value of `view` has one renderer, which gives the tab's title and icon and renders the content. Built-ins use the same lookup a plugin will; plugin views use a namespaced value (`"<plugin>:<name>"`). The lookup stays internal until the plugin work defines how plugins contribute.
- **Identity:** a view's identity is its `view` plus the parameters that select what it shows (for a file, its path; line numbers only move within it). Opening a view that is already open focuses its tab and applies the new parameters, rather than opening a second tab.
- **A view loads what it shows itself**, through the host's APIs (*Host APIs and modules*, below); no feature store is shared between views or containers. What must survive being opened elsewhere (a file's lines, its Code/Preview choice) travels in the view's parameters.

## Containers

- **The Inspector** (desktop: the resizable right pane; mobile: its swipe page, today's Files page). A strip of tabs: open, focus, close, reorder. The changed-files tree is its first tab, and cannot be closed. The Inspector's tabs are per project and remembered on this device, saved as their `View` objects; a saved view whose renderer no longer exists, or whose file is gone, is dropped or shown as unavailable rather than failing the strip.
- **The file browser is not a container.** It is a module of its own (below), shown as a modal; its **Open in Inspector** action asks for a `file` view with the file's path, lines and Code/Preview choice.
- **The main area (reserved, not built):** placing a view in the main area is navigation: a route carries the serialized view, the main area renders it with the same renderer, and Back returns to the conversation. That is how a project dashboard or a pinned plugin app ([pinned-plugin-apps.md](pinned-plugin-apps.md)) would take over the main area. Chat and Changes stay as they are, the default for a session's route. Open: whether this is `workspace.open(view, { in: "main" })` or a separate navigation call, since `open` meaning navigate may confuse.

`in` names a container by ID rather than a closed set. Today the only ID is `"inspector"`. A later layout (user splits, or containers a plugin asks for) adds IDs without changing views or callers. Plugins creating panes, nesting and docking are deferred.

This also ends the double meaning of "files": the changed-files tree is the Inspector's `changes` view, and the project file browser is the file browser.

## Host APIs and modules

Decided 2026-10-21, replacing a per-project file model shared by the file browser, the Inspector and message references (built in slices 1 and 2, then found to couple them). The host offers raw capabilities; features consume them and own their own state. A feature that wants state shared between several of its extensions (a plugin with a view and a decorator over one cache) keeps it inside its own package; that is the plugin case and is not designed here.

- **The project files API** (host, application lifetime, beside the other long-lived stores of `AppStore`): for a checkout (a project and the source it is read from, since ADR-029 on that source's node) it gives the file listing as a loadable to subscribe to, cached per checkout with generation checks, so a response for a checkout no longer asked for cannot land; it reads a file's content (uncached); and it says when a checkout's files may have changed, inferred from the session events that change files (the end of a file-modifying tool, the end of a turn: today's rule in `WorkspaceStore`, kept in one place), refreshing the listings it holds. Events carry the project but not the source, so a change may refresh a checkout that did not change; that is harmless. It hides which route reads which checkout, so moving the file routes to the session's checkout changes only it. No listing while the source's node is offline.
- **The file browser** is a module of its own, mounted by the application shell, unconnected to the workspace: it is opened with a checkout and optionally a path, lines and Code/Preview choice (from the workspace, a tool result, the server's `open_file`), owns its store (directory tree, the open file, its search's query), reads the listing and content through the files API, and refreshes on its change signal. Opening and closing it does not reset it; another checkout starts it over. File search is part of it. **Open in Inspector** dispatches `open-view`, which the workspace handles for its own project.
- **Inspector `file` views** render the shared presentational `file-viewer` with a loader of their own for their one file, through the files API, reading it again when opened again and when the API says the checkout changed.
- **Message decorators:** an internal lookup of decorators applied to completed message text, as views are looked up by name: the Markdown token walk and the plain-text path for user messages are shared, and a decorator only finds its targets in a piece of text and says which view each opens. File references are the first decorator, resolving against the listing from the files API. How plugins add decorators is left to the plugin work, with views.

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

Activating a reference calls `workspace.open({ view: "file", path, startLine, endLine }, { in: "inspector" })`. On mobile that also moves to the Inspector page.

### Inventory and freshness

Reuse the project file listing (from the files API) rather than a second source of filesystem truth, and build an index from it for exact full-path lookup, unique-basename lookup and longest-match candidates. Do not compare every path against every text node.

Refresh the index once after an agent turn completes and through the existing explicit file refresh, so files created during the turn can be cited. Conversations that render before the inventory is ready render normally first and gain file controls when it arrives; cache resolution per inventory generation. When the source's node is offline, there is no inventory and nothing is decorated.

### Markdown decoration

Decoration is a presentation transform. It must not modify persisted message text, provider history, copied message Markdown or compaction input. Apply it through Markdown tokens or rendered text nodes, not a regular expression over generated HTML; existing anchors and code blocks keep their semantics. User and assistant messages are decorated alike.

## Implementation slices

1. **(done)** **The Inspector with files.** The `View` type and renderer lookup with two views (`changes`, `file`); `workspace.open` with `"inspector"`; the Inspector's tab strip on desktop and its swipe page on mobile (open, focus an existing tab, close; the changes tab first and not closable); the `file` view rendering the existing viewer from a per-project file model that survives switching tabs and sessions; **Open in Inspector** from the file browser modal and file search. Not yet: remembered tabs, reordering, the modal as a `workspace.open` container, message references.
2. **(done)** **Message file references:** the reference index, path and line-range parsing, decoration of completed Markdown, opening in the Inspector.
2b. **Host APIs and modules** (*Host APIs and modules*, above), on this branch: the project files API; the file browser and file search as their own module, mounted by the application shell again; Inspector file views loading their own file; message decorators with file references as the first; `FileModel` removed. Behavior as built in slices 1 and 2, except that Open in Inspector carries the Code/Preview choice.
3. **Tabs that last:** tabs remembered per project on this device (with unavailable views handled), and reordering.
4. **The main area** when the first dashboard or pinned app needs it.

To do (not scheduled):

- [ ] **Mobile: the diff review as the Inspector's Changes tab.** On a phone the Changes page (the diff) and the Inspector's Changes tab (the changed-files tree) say the same thing, and the tree only jumps back to the diff. Instead: three pages (Sessions → Chat → Inspector), the Inspector's Changes tab showing the diff review with the changed files as a jump list inside it, and the toolbar's Changes button focusing that tab. Desktop is unchanged. Move the existing review section into the Inspector's page with grid placement rather than rendering a second one, so a resize never remounts it (it is virtualized and holds the inline review composer). Not the main area: nothing is routed; it is a first, mobile-only step toward Changes as a view.
- [x] **Mobile: swiping goes through the Inspector's tabs** (done, 2026-10-21). Each tab is a mobile page after Changes: swiping left from Changes reaches the first tab, further swipes the next ones, and right from the first tab returns to Changes. The workspace surface stops at the Inspector's column and the rest of the drag moves a track of the tabs' panels (laid side by side on phones, stacked at `md`), so the strip stays in place while content slides. Content that scrolls sideways (a file with long unwrapped lines) still keeps horizontal drags, so such a file swipes from its header; an overflowing strip scrolls rather than swipes. With the item above done, the diff becomes the first of those pages without further swipe work.

## Progress and decisions

Slices 1 and 2 were built on a per-project `FileModel` owned by `WorkspaceStore`, with the file browser and file search moved into `app-workspace`. Slice 2b replaces that (*Host APIs and modules*); the decisions below that concern `FileModel`, the file browser living in the workspace, and slice 3 moving view state through the file model are superseded by it.

### Slice 1: the Inspector with files (done, 2026-10-20)

Built as planned: `View`, `viewKey` and `Inspector` in `models/inspector.ts`; the renderer lookup in `components/inspector/views.ts`; `WorkspaceStore.open(view, { in })`, reached from components by the `open-view` event; `FileModel` (`models/stores/file-model.ts`) replacing `FileBrowserStore`. frontend-architecture.md *Views and the Inspector* describes it.

- **Tabs per project, in memory.** `WorkspaceStore` keeps an `Inspector` per project for the page's lifetime, so returning to a project shows its tabs (their files read again). Saving them is slice 3.
- **Closing a tab focuses the tab before it**; a middle click closes too.
- **An open without lines keeps the tab's lines**; an open with lines replaces them and highlights and scrolls again even when they are the same (each open bumps the tab's `revision`, and highlights are requests applied once by ID).
- **Hidden tabs stay rendered**, so a file keeps its scroll position and Code/Preview tab while another tab is shown. The reading position therefore lives in the DOM, not the file model, for now; slice 3 (moving a view between containers) is when it must move into the model.
- **The file browser and file search moved from `app-shell` into `app-workspace`**, which renders them from its `FileModel` as state it owns (`FileBrowserRequest`, `fileSearchOpen`) instead of driving them through queried elements. Every way to open them was already inside the workspace.
- **The file model loads the listing as soon as it has a source** (file search, and slice 2's references, read it), and only while the source's node is connected. An explicit open (the file browser, a tab opened again) reads the file again while the old content stays shown; switching tabs reads nothing; the end of an agent turn reloads the listing, listed directories and loaded files.
- **Scoped to the viewed session's source, read from the default one.** The model's scope is the session's project, node and checkout path, so another source starts it over. The file routes still read the project's default source (node-contract.md *Which checkout a call works in*); making them read the session's checkout is separate server work, after which only the model's requests change.
- **The right pane got wider:** its default width is 320 px (was 240) and it can grow to 960 px (was 400), still leaving the center its minimum. Saved widths keep their storage key.
- **The tab strip matches the center toolbar:** rounded tabs within the 50 px row, the active one raised like the toolbar's branch pill rather than square editor tabs joined to the content, since the content below starts with its own header rows. The current tab scrolls into view (on open and on resize), a mouse wheel scrolls the strip, the × shows on the current and hovered tab (always on touch), and a cut-short name keeps its extension. A file tab's header shows the directory muted and left-truncated, the file name in full.
- **Open in Inspector from file search** is ⌘/Ctrl+Enter (a new `palette-alternate-confirm` event of `search-palette`) or an Inspector button on each result row (`renderItemAction`), for touch.

### Slice 2: message file references (done, 2026-10-20)

Built as planned: `FileReferenceIndex` (`models/file-references.ts`), `FileModel.references`, Markdown decoration through marked tokens in `components/markdown-content.ts`, and plain-text segments for user messages. frontend-architecture.md *Message file references* describes it; workspace-panes.md *File references in messages* is the user's view.

- **Exactly the files the listing has.** Full relative paths (a leading `./` allowed) and absolute paths under the checkout resolve exactly; a bare basename resolves when unique; a partial path (`components/app.ts`) does not resolve, even when it would be unique. Gitignored files (not in the listing) are never linked.
- **Line suffixes:** `:12`, `:12-20`, `:12:5` (the column is dropped), `#L12`, `#L12-L20`. A single line opens with `startLine` only; a reversed range is put in order.
- **Words, then trimming.** Prose is split at whitespace; a word is a candidate only if it has a `.` or `/` and no `://`. Opening brackets, quotes, backticks and `*` are trimmed from its start, and sentence punctuation, closing brackets, quotes, backticks and `*` from its end, trying the longest candidate first, so `(README.md:4),` links `README.md:4`. An underscore is never trimmed (`__init__.py`).
- **Inline code** is decorated when its whole text is a reference, the code styling kept inside the control.
- **Controls are buttons** (`<button class="file-reference">`), not anchors, so no URL or hash changes; they are styled as the text underlined with dots.
- **User messages** are plain text, so they are decorated by `segments()` directly (fenced regions skipped), not through Markdown.
- **Refresh:** the listing (and with it the index) reloads when the viewed session's agent turn ends (`agent_end`) and through `FileModel.refresh()`; there is no other explicit refresh control in the UI yet.
- **Which checkout:** references resolve against the session's checkout path, but the listing comes from the project's default source until the file routes read the session's checkout (slice 1's note). For a session on another node the two can disagree.

## Verification

Cover at least:

- `workspace.open` opens a tab, focuses an existing one for the same file and applies new line parameters
- closing tabs and reordering; the changes tab cannot be closed
- tabs restored per project after reload; unknown views and missing files handled
- Open in Inspector from the file browser carries the file's lines and Code/Preview choice
- the file browser, Inspector file views and message references stay fresh after the agent changes files, without sharing a store
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
- how plugins contribute views (the plugin work)
- browser-addressable file routes or a URL scheme for files
- editing files
