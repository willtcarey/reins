# Workspace Inspector, Views and Message File References

Status: **proposed**

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

1. **The Inspector with files.** The `View` type and renderer lookup with two views (`changes`, `file`); `workspace.open` with `"inspector"`; the Inspector's tab strip on desktop and its swipe page on mobile (open, focus an existing tab, close; the changes tab first and not closable); the `file` view rendering the existing viewer from a per-project file model that survives switching tabs and sessions; **Open in Inspector** from the file browser modal and file search. Not yet: remembered tabs, reordering, the modal as a `workspace.open` container, message references.
2. **Message file references:** the reference index, path and line-range parsing, decoration of completed Markdown, opening in the Inspector.
3. **Tabs that last:** tabs remembered per project on this device (with unavailable views handled), reordering, the file browser's file view opened through `workspace.open(..., { in: "modal" })` and moved to the Inspector with its view state.
4. **The main area** when the first dashboard or pinned app needs it.

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
