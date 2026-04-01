# File Browser

A read-only file browser overlay for viewing any file in the project repository.

## How to Open

| Shortcut | Action |
|---|---|
| `Cmd+P` / `Ctrl+P` | Opens fuzzy file search |
| `Escape` | Closes the overlay or goes back to search from viewer |
| Click outside overlay | Closes the overlay |

## Fuzzy File Search

The search palette indexes all non-ignored files in the project (`git ls-files` + untracked non-ignored files). As you type, files are fuzzy-matched and ranked by match quality. Matching characters are highlighted in blue.

Keyboard navigation:
- `↑` / `↓` — move selection
- `Enter` — open selected file
- `Escape` — close

## File Viewer

Selecting a file opens a syntax-highlighted, read-only viewer with:

- **Line numbers** in the left gutter
- **Syntax highlighting** via Shiki (same highlight worker used for diffs)
- **Large file truncation** — files over 5,000 lines show a "Showing first N of M lines" message
- **Binary detection** — binary files show a size message instead of content

The back arrow (`←`) or `Escape` returns to the search palette.

## Programmatic Access

The `<file-browser>` component exposes:
- `open()` — opens the search palette
- `openFile(path)` — opens directly to a specific file
