# File Browser Overlay

Status: **Phase 1 complete** — fuzzy search + file viewer shipped. Phase 2 (tree sidebar) not started.

## Bug fixes / polish

- [x] Search palette changes width as you type — fixed with `px-4` on backdrop + `min-w-0` on result buttons for proper truncation
- [x] File icons in the search palette are unclear emoji — removed entirely
- [x] Escape doesn't close the file browser — centralized Escape handling in `<file-browser>`, removed from child components
- [x] Reuse the same palette shell as quick-open — extracted `<search-palette>` component, both quick-open and file-search use it
- [x] File viewer should use `shouldWrapLines(path)` for per-file-type line wrapping, matching diff viewer behavior
- [x] File viewer overlay goes full-screen on mobile (100vw × 100dvh, no rounded corners/ring) — centered 90vw × 90vh on desktop
- [x] When opening the file browser from a read or edit tool result, highlight the relevant line range in the file viewer (e.g. the lines that were read, or the lines affected by the edit). The `open-in-browser` event carries optional `startLine`/`endLine`, the store holds `highlightRange`, and `<file-viewer-code>` highlights and scrolls to the range.
- [x] No way to open file search on mobile — needs a button somewhere (Cmd+P requires a keyboard). Added search icon button in the file browser header bar (visible on mobile only via `sm:hidden`).
- [x] Reject paths outside the project directory — defense in depth: frontend `isBrowsablePath()` rejects absolute paths and `..` traversal so they don't become clickable links or fire `open-in-browser` events; `handleOpenInBrowser` in app shell double-checks; backend `assertInsideProject()` validates resolved paths in `readFile()` and returns 400. All layers covered by tests.
- [ ] File content not live-updated: if the agent writes to a file while the browser is open to that file, the viewer shows stale content. The store would need to re-fetch on working tree changes, and the code viewer would need to detect content changes at the same path and re-highlight.

## Motivation

Users have no way to view arbitrary files in the repo. Visibility is limited to files that appear in diffs (changed files) or tool results (read/write calls in chat). There's no way to browse the codebase, check a file the agent mentioned, or get oriented in an unfamiliar area — without switching to an external editor.

A full IDE-style file browser is overkill. The goal is read-only access to any file in the repo with minimal friction.

## Phase 1 — Completed

### What shipped

- **Keyboard shortcut**: `Cmd+P` / `Ctrl+P` opens fuzzy file search. No conflict — quick-open uses `Cmd+K`.
- **Backend endpoint**: `GET /api/projects/:id/files` — runs `git ls-files` + `git ls-files --others --exclude-standard` in parallel, returns sorted deduplicated list.
- **Fuzzy file search** (`<file-search>`): standalone palette (like quick-open) with fuzzy matching (reuses `fuzzyMatch` from quick-open-store), match character highlighting, keyboard navigation (↑/↓/Enter/Esc). Dispatches `open-in-browser` on selection.
- **File viewer** (`<file-viewer>`): syntax-highlighted read-only viewer with line numbers, Shiki highlighting via shared worker, binary file detection, large file truncation (5,000 lines), per-file-type line wrapping.
- **Viewer overlay** (`<file-browser>`): wraps `<file-viewer>` in a backdrop. Exposes `openFile(path)` — opens fresh or updates in place if already open.
- **Store** (`FileBrowserStore`): file list fetching (cached per project), content loading via existing `/api/projects/:id/file` endpoint, fuzzy filtering. Shared by `<file-search>` and `<file-browser>`.
- **Entry points**: clickable file paths in read/edit/write tool blocks, view button in diff file card headers — all dispatch `open-in-browser`.
- **UI layers**: z-index system via CSS variables (`--layer-content`, `--layer-sidebar`, `--layer-overlay`, `--layer-palette`, `--layer-toast`). File search (palette layer) renders above the file viewer (overlay layer), allowing file switching while the viewer is open.

### Architecture

Three independent components with clear responsibilities:

| Component | Role |
|---|---|
| `<file-search>` | Standalone search palette — owns `Cmd+P` shortcut, open/close state. Dispatches `open-in-browser` on file select. |
| `<file-browser>` | Viewer overlay shell — wraps `<file-viewer>`, opens via `openFile(path)`. Escape/close dismisses. |
| `<file-viewer>` | Content viewer — highlighting, line numbers, loading/error states. Fires `close`. |

All entry points converge on a single bubbling `open-in-browser` CustomEvent, caught by `<app-shell>` which calls `fileBrowser.openFile(path)`.

### Resolved questions

1. **~~Conflict with quick-open~~**: No conflict. Quick-open is `Cmd+K`, file search is `Cmd+P`.
2. **~~File tree data source~~**: Tree sidebar (Phase 2) will use `readdir`. Fuzzy search uses `git ls-files` + untracked non-ignored.
3. **Caching/freshness**: File list is cached per project and fetched on overlay open. `store.refreshFiles()` exists for forced refresh.

## Phase 2 — In progress

### Implementation checklist

- [x] Backend `GET /files/tree` endpoint (`ProjectModel.listDirectory`) — lazy readdir, one level, path traversal protection
- [x] Store tree state — `directoryEntries` cache, `expandedDirs`, `treeLoading`, `fetchDirectory()`, `toggleDirectory()`, `expandToPath()`
- [x] `<file-tree>` component — directory tree with expand/collapse, click to open file, highlight active file
- [x] Layout refactor in `<file-browser>` — header bar + tree sidebar + viewer in flex row
- [x] Auto-expand tree to show current file when opened via search or entry point
- [x] Inline image/PDF previews for binary files in `<file-viewer>`
- [x] Inline image/PDF previews in diff file cards (`<diff-file-card>`)
- [x] Markdown preview with code/preview toggle in `<file-viewer>`
- [x] Mobile support — tree as slide-out panel, button to open file search
- [x] Migrated `<file-viewer-code>` and `<diff-hunk>` from eager `HighlightController` to `LazyHighlightController` — all highlighting consumers now use the same lazy controller
- [x] Line range highlighting when opening from read/edit tool results (Phase 1 bug)

### Tree sidebar

Add a directory tree panel alongside the file viewer, powered by lazy `readdir` (one level at a time). This lets users browse the full directory structure including gitignored files that don't appear in fuzzy search.

### UX Design

```
┌──────────────────────────────────────────────┐
│  file path                              [✕]  │
│──────────┬───────────────────────────────────│
│          │                                    │
│  file    │  file content                      │
│  tree    │  (syntax highlighted, read-only,   │
│          │   line numbers)                     │
│          │                                    │
│          │                                    │
│          │                                    │
└──────────┴───────────────────────────────────┘
```

**Layout:**
- Left panel: collapsible file tree sidebar for browsing
- Right panel: file content viewer (takes most of the width)
- Top bar: current file path + close button

**Search is external:** `Cmd+P` opens the standalone file search palette (palette layer) on top of the viewer (overlay layer). Selecting a file updates the viewer in place and the tree auto-expands to show the file's location.

### Navigation within the overlay

Once the overlay is open, the user can:

- **Click files in the tree** to view them. The tree shows the repo directory structure with expand/collapse on directories.
- **Press `Cmd+P`** to open the file search palette on top, pick a file, and the viewer updates in place.
- **Click breadcrumbs** at the top of the content pane to navigate up the directory hierarchy.
- **Keyboard navigation**: `↑`/`↓` to move through tree, `Enter` to open, `Escape` to close the overlay.
- **Browser back** should close the overlay (treat it as a layer, not a route).

### Tree behavior

- Directories expand/collapse on click. Only the expanded directory's children are loaded (lazy — one level at a time).
- The currently viewed file is highlighted in the tree.
- When opening a file from search, its parent directories auto-expand so the file is visible in the tree context. This lets the user see sibling files and explore the neighborhood.
- Changed files (from the current diff) could be badged or highlighted to show what's been modified.

### Inline preview for images and PDFs

Instead of showing "Binary file (X KB)" for non-text files, render inline previews where possible:

- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`): render an `<img>` tag pointing at the existing `/files/content` endpoint.
- **PDFs**: render in an `<iframe>` or `<embed>` using the same endpoint.

The content endpoint already serves the correct `Content-Type` and raw bytes, so the frontend just needs to build an object URL or point the element at the endpoint directly. Simple to implement, big UX improvement over a dead-end "Binary file" message.

### Mobile

On mobile (or narrow viewports), the tree sidebar is hidden by default. The search-first entry point works well on mobile since there's no tree to navigate. The overlay takes the full screen. A hamburger or back-arrow reveals the tree as a slide-out panel if needed.

## Phase 3 — Agent-triggered file viewing (complete)

The agent can open the file browser to a specific file via the `execute` tool: `api.ui.openFile("src/index.ts")`, optionally with `startLine` and `endLine` for line range highlighting.

### What shipped
- **`ui.openFile()` API function** (`packages/backend/src/scripting/ui.ts`): registered in the API registry, discoverable via the `search` tool
- **`open_file` WS message type**: added to backend `ServerMessage` and frontend `ServerMessage`/`FrontendEvent`
- **Frontend handling**: `AppStore.onOpenFile` callback, wired in `app.ts` to call `fileBrowser.openFile(path, highlight?)`
- **Chat panel**: ignores `open_file` events (like other non-chat events)

## Entry points

| Action | Status | Result |
|---|---|---|
| `Cmd+P` / `Ctrl+P` | ✅ Shipped | Opens fuzzy file search overlay. |
| Click file path in read tool result | ✅ Shipped | Opens overlay to that file via `openFile(path)`. |
| Click file path in edit tool result | ✅ Shipped | Opens overlay to that file via `openFile(path)`. |
| Click file path in write tool result | ✅ Shipped | Opens overlay to that file via `openFile(path)`. |
| 👁 button in diff file card header | ✅ Shipped | Opens overlay to that file via `openFile(path)`. |
| Agent calls `api.ui.openFile(path)` | ✅ Shipped | Opens overlay to that file (via WS broadcast). Supports optional `startLine`/`endLine`. |

All entry points use a bubbling `open-in-browser` CustomEvent caught by `<app-shell>`, which calls `fileBrowser.openFile(path)`.

## What it is NOT

- Not an editor. No editing, saving, or conflict resolution.
- Not a git history viewer. Shows the working tree as-is, not diffs or blame.
- Not a new tab or route. It's a transient overlay — open, look, close.
- Not a replacement for the changes tab. Changed files still live in the diff view with their hunks and expand controls.
- Not a general-purpose file viewer. Only files within the project directory can be viewed — paths that resolve outside the project root (e.g. via `../` traversal or absolute paths) must be rejected by the backend. This is a security boundary, not just a UX choice.

## Open questions

_Working notes — the agent can leave observations, unresolved issues, or design questions here as they come up during implementation._
