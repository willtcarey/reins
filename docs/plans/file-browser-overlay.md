# File Browser Overlay

Status: **Phase 1 complete** — fuzzy search + file viewer shipped. Phase 2 (tree sidebar) not started.

## Bug fixes / polish

- [x] Search palette changes width as you type — fixed with `px-4` on backdrop + `min-w-0` on result buttons for proper truncation
- [x] File icons in the search palette are unclear emoji — removed entirely
- [x] Escape doesn't close the file browser — centralized Escape handling in `<file-browser>`, removed from child components
- [x] Reuse the same palette shell as quick-open — extracted `<search-palette>` component, both quick-open and file-search use it

## Motivation

Users have no way to view arbitrary files in the repo. Visibility is limited to files that appear in diffs (changed files) or tool results (read/write calls in chat). There's no way to browse the codebase, check a file the agent mentioned, or get oriented in an unfamiliar area — without switching to an external editor.

A full IDE-style file browser is overkill. The goal is read-only access to any file in the repo with minimal friction.

## Phase 1 — Completed

### What shipped

- **Keyboard shortcut**: `Cmd+P` / `Ctrl+P` opens fuzzy file search. No conflict — quick-open uses `Cmd+K`.
- **Backend endpoint**: `GET /api/projects/:id/files` — runs `git ls-files` + `git ls-files --others --exclude-standard` in parallel, returns sorted deduplicated list.
- **Fuzzy file search** (`<file-search>`): palette with fuzzy matching (reuses `fuzzyMatch` from quick-open-store), match character highlighting, file type icons, keyboard navigation (↑/↓/Enter/Esc).
- **File viewer** (`<file-viewer>`): syntax-highlighted read-only viewer with line numbers, Shiki highlighting via shared worker, binary file detection, large file truncation (5,000 lines).
- **Overlay shell** (`<file-browser>`): manages open/close, mode routing, backdrop. Exposes `open()` and `openFile(path)` for programmatic triggers.
- **Store** (`FileBrowserStore`): file list fetching (cached per project), content loading via existing `/api/projects/:id/file` endpoint, fuzzy filtering.

### Architecture

Three components with clear responsibilities:

| Component | Role |
|---|---|
| `<file-browser>` | Overlay shell — open/close, keyboard shortcut, mode routing |
| `<file-search>` | Search palette — input, results, keyboard nav. Fires `file-select` and `close` |
| `<file-viewer>` | Content viewer — highlighting, line numbers, loading/error states. Fires `back` and `close` |

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
│  🔍 [search/filter bar]                 [✕]  │
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
- Top bar: search/filter input (filters the tree and/or does fuzzy file search) + close button

### Navigation within the overlay

Once the overlay is open, the user can:

- **Click files in the tree** to view them. The tree shows the repo directory structure with expand/collapse on directories.
- **Use the search bar** to fuzzy-filter the tree or jump to a file by name. This reuses the same search as the initial `Cmd+P` entry — it just runs inside the overlay instead of opening a new one.
- **Click breadcrumbs** at the top of the content pane to navigate up the directory hierarchy.
- **Keyboard navigation**: `↑`/`↓` to move through tree or search results, `Enter` to open, `Escape` to close the overlay.
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

## Future entry points (not yet wired)

| Action | Result |
|---|---|
| Click file path in read tool result | Opens overlay to that file via `openFile(path)`. |
| Click file path in edit tool result | Opens overlay to that file via `openFile(path)`. |
| Click file path header in diff view | Opens overlay to that file via `openFile(path)`. |
| Agent calls `api.ui.openFile(path)` | Opens overlay to that file (via WS broadcast). |

## What it is NOT

- Not an editor. No editing, saving, or conflict resolution.
- Not a git history viewer. Shows the working tree as-is, not diffs or blame.
- Not a new tab or route. It's a transient overlay — open, look, close.
- Not a replacement for the changes tab. Changed files still live in the diff view with their hunks and expand controls.

## Open questions

_Working notes — the agent can leave observations, unresolved issues, or design questions here as they come up during implementation._
