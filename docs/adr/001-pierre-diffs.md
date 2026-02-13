# ADR-001: Evaluated `@pierre/diffs` for Diff Viewer

- **Status:** Rejected
- **Date:** 2026-02-13
- **Author:** Will (with Claude)

## Context

Herald has a custom diff viewer consisting of:

- **`packages/frontend/src/diff-panel.ts`** — a Lit web component (~230 lines) that renders syntax-highlighted unified diffs with collapsible files, hunk separators, and context expansion.
- **`packages/backend/src/highlighter.ts`** — highlight.js-based syntax highlighter (~130 lines) that tokenizes full files and splits highlighted HTML across lines with balanced span tags.
- **`packages/backend/src/git.ts`** — contains `parseUnifiedDiff()` (~100 lines) for parsing raw `git diff` output and `getHighlightedDiff()` (~70 lines) for assembling a pre-highlighted diff structure.
- **`packages/backend/src/routes/diff.ts`** — serves the pre-parsed, pre-highlighted diff JSON to the frontend.

We evaluated [`@pierre/diffs`](https://diffs.com) (v1.0.10) as a potential replacement.

## What `@pierre/diffs` Offers

- Full diff rendering component (`FileDiff`) with split and unified views
- Shiki-based syntax highlighting (replaces highlight.js)
- Word-level and character-level inline diff highlighting
- Built-in hunk expansion (up/down/both directions)
- Line selection and hover utilities
- Annotation framework
- Theme support (light/dark, custom CSS variable themes)
- Patch parsing via `parsePatchFiles()` and file diffing via `parseDiffFromFile()`

## What It Would Make Obsolete

| Current Code | Purpose | Replacement in `@pierre/diffs` |
|---|---|---|
| `frontend/src/diff-panel.ts` | Custom diff rendering UI | `FileDiff` component |
| `backend/src/highlighter.ts` | highlight.js tokenization | Shiki (runs client-side) |
| `backend/src/git.ts` — `parseUnifiedDiff()` | Unified diff parser | `parsePatchFiles()` |
| `backend/src/git.ts` — `getHighlightedDiff()` | Pre-highlighted diff assembly | `renderDiffWithHighlighter()` |
| `backend/src/routes/diff.ts` | Structured diff API | Simplified to return raw data |
| `highlight.js` backend dependency | Server-side highlighting | Removed entirely |

## Key Finding: Syntax Highlighting Requires Full File Contents

`@pierre/diffs` has two rendering paths:

1. **Full files available** (`parseDiffFromFile(oldFile, newFile)`) — stores complete `oldLines`/`newLines` on the diff metadata. Shiki highlights entire files for accurate tokenization. Hunk expansion works because all lines are available.

2. **Patch-only** (`parsePatchFiles(rawDiff)`) — only hunk fragments are available. Shiki highlights each hunk independently, which means:
   - Syntax highlighting is **approximate** (no cross-hunk context for multi-line strings, block comments, etc.)
   - Hunk expansion is **disabled** (no lines to expand into)
   - Collapsed region rendering is **limited**

To get the full feature set, the backend would still need to serve the **full old and new file contents** for every changed file — not just the raw diff. This shifts highlighting work to the client but increases payload size.

## Decision

**Rejected.** The current implementation is working well and is lightweight (~530 lines total across frontend and backend). Adopting `@pierre/diffs` would:

- Add ~6 transitive dependencies (shiki, diff, hast-util-to-html, lru_map, etc.) and meaningfully increase the client bundle size.
- Require sending full file contents to the frontend for proper highlighting and hunk expansion — negating the backend simplification benefit.
- Move syntax highlighting to the client, increasing time-to-first-paint for large diffs.
- Introduce a library with a much larger API surface than we need.

The trade-off isn't worth it at this time. If we later need split-view diffs, word-level inline highlighting, or an annotation framework, this decision should be revisited.
