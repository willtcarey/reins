# File Browser

A read-only file browser overlay for viewing any file in the project repository.

## How to Open

| Action | Result |
|---|---|
| `Cmd+P` / `Ctrl+P` | Opens fuzzy file search |
| Click file path in read/edit/write tool result | Opens file in viewer |
| 👁 button in diff file card header | Opens file in viewer |
| Mobile: search icon in file browser header | Opens fuzzy file search |
| Mobile: hamburger in file browser header | Toggles tree sidebar |

## Closing

- `Escape` — closes the overlay
- Click backdrop (outside the overlay) — closes the overlay

## Fuzzy File Search

The search palette indexes all non-ignored files in the project (`git ls-files` + untracked non-ignored files). As you type, files are fuzzy-matched and ranked by match quality. Matching characters are highlighted in blue.

Keyboard navigation:
- `↑` / `↓` — move selection
- `Enter` — open selected file
- `Escape` — close search

The search palette renders above the viewer (palette layer > overlay layer), so you can switch files while the viewer is open.

## Tree Sidebar

A directory tree panel on the left side of the viewer, powered by lazy `readdir` (one level at a time). Shows the full directory structure including gitignored files that don't appear in fuzzy search.

- Click a directory to expand/collapse it
- Click a file to view it
- The currently viewed file is highlighted in the tree
- When opening a file (from search or tool result), the tree auto-expands to show the file's location

On mobile, the tree is hidden by default and slides out as a panel via the hamburger button.

## File Viewer

Selecting a file opens a syntax-highlighted, read-only viewer with:

- **Line numbers** in the left gutter
- **Syntax highlighting** via Shiki (same highlight worker used for diffs)
- **Per-file-type line wrapping** (e.g. markdown wraps, code doesn't)
- **Large file truncation** — files over 5,000 lines show a "Showing first N of M lines" message
- **Binary detection** — binary files show a size message instead of content
- **Image preview** — `.png`, `.jpg`, `.gif`, `.svg`, `.webp` files render inline
- **PDF preview** — `.pdf` files render in an embedded viewer
- **Markdown preview** — markdown files have a code/preview toggle

## Line Highlighting

Lines can be highlighted with a yellow left-edge indicator and background tint.

### From tool results

When opening the file browser from a **read** or **edit** tool result, the relevant line range is automatically highlighted and scrolled into view:

- **Read tool** — highlights the lines that were read (only when offset/limit was specified, not for full-file reads)
- **Edit tool** — highlights the line range affected by the edit (computed from the diff's new-side line numbers)

### Gutter selection

Click or drag on line numbers in the gutter to highlight a range:

- **Click a line number** — highlights that single line
- **Click and drag across line numbers** — highlights a contiguous range (works in both directions)
- **Click anywhere outside the highlighted range** (on content, not gutter) — clears the highlight

Gutter-initiated highlights do not scroll the viewport — only external highlights (from tool results) trigger auto-scroll.
