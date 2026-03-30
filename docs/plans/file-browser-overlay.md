# File Browser Overlay

Status: **Phase 1 complete** — fuzzy search + file viewer shipped. Phase 2 (tree sidebar) not started.

## Bug fixes / polish

- [x] Search palette changes width as you type — fixed with `px-4` on backdrop + `min-w-0` on result buttons for proper truncation
- [x] File icons in the search palette are unclear emoji — removed entirely
- [x] Escape doesn't close the file browser — centralized Escape handling in `<file-browser>`, removed from child components
- [x] Reuse the same palette shell as quick-open — extracted `<search-palette>` component, both quick-open and file-search use it
- [x] File viewer should use `shouldWrapLines(path)` for per-file-type line wrapping, matching diff viewer behavior
- [x] File viewer overlay goes full-screen on mobile (100vw × 100dvh, no rounded corners/ring) — centered 90vw × 90vh on desktop
- [ ] When opening the file browser from a read or edit tool result, highlight the relevant line range in the file viewer (e.g. the lines that were read, or the lines affected by the edit). The `open-in-browser` event would need to carry optional line range info, and the viewer would scroll to and highlight those lines.
- [ ] No way to open file search on mobile — needs a button somewhere (Cmd+P requires a keyboard)
- [ ] Reject paths outside the project directory — the backend must validate that resolved paths don't escape the project root (e.g. via `../` traversal or absolute paths)

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

## Phase 2 — Not started

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

### Image preview

Detect image file extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`) and render an `<img>` tag pointing at the existing file content endpoint instead of showing "Binary file detected". Simple to implement, big UX improvement.

### Mobile

On mobile (or narrow viewports), the tree sidebar is hidden by default. The search-first entry point works well on mobile since there's no tree to navigate. The overlay takes the full screen. A hamburger or back-arrow reveals the tree as a slide-out panel if needed.

## Phase 3 — Agent-triggered file viewing (not started)

The agent could open the file browser to a specific file via the `execute` tool (e.g., `api.ui.openFile("src/index.ts")`). Requires:
- A new outbound WS message type: `{ type: "open_file", path: string }`
- Backend plumbing to broadcast it when the execute tool calls `api.ui.openFile()`
- Frontend WS listener that calls `fileBrowser.openFile(path)` on receipt
- UX consideration: what happens if the user is mid-typing or has another overlay open?

## Entry points

| Action | Status | Result |
|---|---|---|
| `Cmd+P` / `Ctrl+P` | ✅ Shipped | Opens fuzzy file search overlay. |
| Click file path in read tool result | ✅ Shipped | Opens overlay to that file via `openFile(path)`. |
| Click file path in edit tool result | ✅ Shipped | Opens overlay to that file via `openFile(path)`. |
| Click file path in write tool result | ✅ Shipped | Opens overlay to that file via `openFile(path)`. |
| 👁 button in diff file card header | ✅ Shipped | Opens overlay to that file via `openFile(path)`. |
| Agent calls `api.ui.openFile(path)` | Not started | Opens overlay to that file (via WS broadcast). |

All entry points use a bubbling `open-in-browser` CustomEvent caught by `<app-shell>`, which calls `fileBrowser.openFile(path)`.

## What it is NOT

- Not an editor. No editing, saving, or conflict resolution.
- Not a git history viewer. Shows the working tree as-is, not diffs or blame.
- Not a new tab or route. It's a transient overlay — open, look, close.
- Not a replacement for the changes tab. Changed files still live in the diff view with their hunks and expand controls.
- Not a general-purpose file viewer. Only files within the project directory can be viewed — paths that resolve outside the project root (e.g. via `../` traversal or absolute paths) must be rejected by the backend. This is a security boundary, not just a UX choice.

## Open questions

_Working notes — the agent can leave observations, unresolved issues, or design questions here as they come up during implementation._
