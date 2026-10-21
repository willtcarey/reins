# Workspace Inspector, Views and Message File References

Status: **in progress**: slices 1 and 2 done (2026-10-20); slices 3 and 4 remain.

## Goal

Keep things in reach while working in the main area, and make file references in messages open them.

- **The Inspector:** the right-hand area of the workspace becomes a strip of tabs. Each tab shows a view: the changed-files tree, a file, and later whatever plugins provide. A plan document can stay open beside the conversation.
- **Views opened through one call:** `workspace.open(view, { in })` shows a view in the Inspector or in a modal. Message links, file search, the file browser and tool actions all open files through it.
- **File references in messages:** real project files mentioned in completed messages become controls that open them in the Inspector.

## Views

A view is a plain, serializable object whose `view` field names what it shows; the rest are its parameters:

```ts
type View =
  | { view: "changes" }
  | { view: "file"; path: string; startLine?: number; endLine?: number };
// later, from plugins: { view: "github:pr", number: 412 }

workspace.open(view: View, options?: { in?: "inspector" | "modal" }): void
```

- **Renderers are looked up by `view`.** Each value of `view` has one renderer, which gives the tab's title and icon and renders the content. Built-ins use the same lookup a plugin will; plugin views use a namespaced value (`"<plugin>:<name>"`). The lookup stays internal until the plugin work defines how plugins contribute.
- **Identity:** a view's identity is its `view` plus the parameters that select what it shows (for a file, its path; line numbers only move within it). Opening a view that is already open focuses its tab and applies the new parameters, rather than opening a second tab.
- **State belongs to the view's model, not its container.** A file's loaded content, preview mode and reading position live in the file model of the project, so moving a view from the modal to the Inspector keeps them.

## Containers

- **The Inspector** (desktop: the resizable right pane; mobile: its swipe page, today's Files page). A strip of tabs: open, focus, close, reorder. The changed-files tree is its first tab, and cannot be closed. The Inspector's tabs are per project and remembered on this device, saved as their `View` objects; a saved view whose renderer no longer exists, or whose file is gone, is dropped or shown as unavailable rather than failing the strip.
- **A modal:** transient. The project file browser stays a modal for now; its file view has an **Open in Inspector** action that moves the current file into a tab.
- **The main area (reserved, not built):** placing a view in the main area is navigation: a route carries the serialized view, the main area renders it with the same renderer, and Back returns to the conversation. That is how a project dashboard or a pinned plugin app ([pinned-plugin-apps.md](pinned-plugin-apps.md)) would take over the main area. Chat and Changes stay as they are, the default for a session's route. Open: whether this is `workspace.open(view, { in: "main" })` or a separate navigation call, since `open` meaning navigate may confuse.

`in` names a container by ID rather than a closed set. Today the IDs are `"inspector"` and `"modal"`. A later layout (user splits, or containers a plugin asks for) adds IDs without changing views or callers. Plugins creating panes, nesting and docking are deferred.

This also ends the double meaning of "files": the changed-files tree is the Inspector's `changes` view, and the project file browser is the file browser.

## File model

One long-lived file model per project, scoped to the source of the session being viewed (since ADR-029 a project's files are read from that source's node). It owns:

- the project file inventory and a reference index built from it
- per-file content, MIME/binary state, loading and errors
- per-file view state: code/preview mode, line highlighting, reading position
- generation checks, so responses for an old project or source cannot update the current one

Hiding a view, closing the modal or switching sessions within the project does not reset it. Changing project (or the viewed session's source) resets it. Content is reloaded rather than persisted across application restarts.

Today the file browser's store resets when its overlay opens or closes, and the browser is driven imperatively through a queried element; both go.

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

Reuse the existing project file listing rather than a second source of filesystem truth, and build an index from it for exact full-path lookup, unique-basename lookup and longest-match candidates. Do not compare every path against every text node.

Refresh the index once after an agent turn completes and through the existing explicit file refresh, so files created during the turn can be cited. Conversations that render before the inventory is ready render normally first and gain file controls when it arrives; cache resolution per inventory generation. When the source's node is offline, there is no inventory and nothing is decorated.

### Markdown decoration

Decoration is a presentation transform. It must not modify persisted message text, provider history, copied message Markdown or compaction input. Apply it through Markdown tokens or rendered text nodes, not a regular expression over generated HTML; existing anchors and code blocks keep their semantics. User and assistant messages are decorated alike.

## Implementation slices

1. **(done)** **The Inspector with files.** The `View` type and renderer lookup with two views (`changes`, `file`); `workspace.open` with `"inspector"`; the Inspector's tab strip on desktop and its swipe page on mobile (open, focus an existing tab, close; the changes tab first and not closable); the `file` view rendering the existing viewer from a per-project file model that survives switching tabs and sessions; **Open in Inspector** from the file browser modal and file search. Not yet: remembered tabs, reordering, the modal as a `workspace.open` container, message references.
2. **(done)** **Message file references:** the reference index, path and line-range parsing, decoration of completed Markdown, opening in the Inspector.
3. **Tabs that last:** tabs remembered per project on this device (with unavailable views handled), reordering, the file browser's file view opened through `workspace.open(..., { in: "modal" })` and moved to the Inspector with its view state.
4. **The main area** when the first dashboard or pinned app needs it.

To do (not scheduled):

- [ ] **Mobile: the diff review as the Inspector's Changes tab.** On a phone the Changes page (the diff) and the Inspector's Changes tab (the changed-files tree) say the same thing, and the tree only jumps back to the diff. Instead: three pages (Sessions → Chat → Inspector), the Inspector's Changes tab showing the diff review with the changed files as a jump list inside it, and the toolbar's Changes button focusing that tab. Desktop is unchanged. Move the existing review section into the Inspector's page with grid placement rather than rendering a second one, so a resize never remounts it (it is virtualized and holds the inline review composer). Not the main area: nothing is routed; it is a first, mobile-only step toward Changes as a view.

## Progress and decisions

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
- moving a file from the modal to the Inspector keeps its view state
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
