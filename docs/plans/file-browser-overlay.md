# File Browser Overlay

Status: **design** — not ready for implementation.

## Motivation

Users have no way to view arbitrary files in the repo. Visibility is limited to files that appear in diffs (changed files) or tool results (read/write calls in chat). There's no way to browse the codebase, check a file the agent mentioned, or get oriented in an unfamiliar area — without switching to an external editor.

A full IDE-style file browser is overkill. The goal is read-only access to any file in the repo with minimal friction.

## UX Design

### Entry point: fuzzy file search

A keyboard shortcut (`Cmd+P` / `Ctrl+P`) opens a fuzzy search palette, similar to the existing quick-open palette. The search is powered by `git ls-files` (cached) so it's fast even on large repos and naturally excludes gitignored files.

The palette shows matching file paths as the user types. Selecting a file opens the file browser overlay with that file displayed.

This means the primary access pattern is: **know roughly what file you want → search → view**. No tree navigation required for the common case.

### The overlay

A full-screen overlay (like a modal, dismissible with `Escape`) that sits on top of the current view — chat, changes, whatever. The user's place is preserved underneath.

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

### File content viewer

- Read-only, syntax highlighted (via the existing Shiki worker, using file extension for language detection).
- Line numbers in the gutter.
- Markdown files get a rendered preview (reuse `markdown-content`) with a toggle to see raw source.
- Binary files show a simple "Binary file, N bytes" message (or an image preview for image files).
- Large files should truncate with a "Show more" affordance rather than rendering 50k lines of DOM.

### Mobile

On mobile (or narrow viewports), the tree sidebar is hidden by default. The search-first entry point works well on mobile since there's no tree to navigate. The overlay takes the full screen. A hamburger or back-arrow reveals the tree as a slide-out panel if needed.

## How it's accessed

| Action | Result |
|---|---|
| `Cmd+P` / `Ctrl+P` | Opens fuzzy file search. Selecting a result opens the overlay. |
| Click file path in read tool result | Opens overlay to that file. |
| Click file path in edit tool result | Opens overlay to that file. |
| Click file path header in diff view | Opens overlay to that file. |
| Agent calls `api.ui.openFile(path)` | Opens overlay to that file (via WS broadcast). |
| Click file in overlay tree | Views that file in the content pane. |
| Search bar within overlay | Filters tree / fuzzy matches files. Selecting one views it. |
| `Escape` | Closes the overlay (or collapses search if focused). |
| Click ✕ button | Closes the overlay. |
| Click outside overlay | Closes the overlay. |

## What it is NOT

- Not an editor. No editing, saving, or conflict resolution.
- Not a git history viewer. Shows the working tree as-is, not diffs or blame.
- Not a new tab or route. It's a transient overlay — open, look, close.
- Not a replacement for the changes tab. Changed files still live in the diff view with their hunks and expand controls.

## Open questions

1. **Conflict with quick-open**: `Cmd+P` currently opens the session quick-open palette. Need a different shortcut for file search, or combine them into one palette with a mode prefix (e.g., typing `>` switches to file mode, similar to VS Code). Alternatively, a different shortcut like `Cmd+Shift+P` or `Cmd+O`.
2. **~~File tree data source~~**: Tree sidebar uses `readdir` (one level at a time, lazy) to show everything on disk including gitignored files. Fuzzy search indexes only non-ignored files (`git ls-files` + `git ls-files --others --exclude-standard`) to stay fast. Gitignored files are only reachable by navigating the tree.
3. **Caching/freshness**: How often to refresh the file list? On overlay open? On a timer? After agent tool calls that might create files?
4. **Deep linking**: Should the overlay be URL-addressable (e.g., `#/project/1/file/src/index.ts`)? Useful for sharing, but adds routing complexity.
5. **Integration with chat**: Should the file browser have a "Send to chat" action — e.g., "Ask the agent about this file"? Or a "Copy path" button for pasting into the chat input?
6. **Agent-triggered file viewing**: The agent could open the file browser to a specific file via the `execute` tool (e.g., `api.ui.openFile("src/index.ts")`). This would let the agent show relevant files during a conversation — "let me show you what I'm looking at." Would need a UI API surface exposed to the execute tool and a way to push a frontend action from the backend (broadcast a WS event that the frontend handles by opening the overlay).
