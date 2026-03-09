# ADR-001: Evaluated `@pierre/diffs` for Diff Viewer

- **Status:** Rejected (twice)
- **Date:** 2026-02-13 (original), 2026-03-06 (revisited)
- **Author:** Will (with Claude)

## Context

REINS has a custom diff viewer consisting of:

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

## First Decision (2026-02-13)

**Rejected.** The current implementation is working well and is lightweight (~530 lines total across frontend and backend). Adopting `@pierre/diffs` would:

- Add ~6 transitive dependencies (shiki, diff, hast-util-to-html, lru_map, etc.) and meaningfully increase the client bundle size.
- Require sending full file contents to the frontend for proper highlighting and hunk expansion — negating the backend simplification benefit.
- Move syntax highlighting to the client, increasing time-to-first-paint for large diffs.
- Introduce a library with a much larger API surface than we need.

The trade-off isn't worth it at this time. If we later need split-view diffs, word-level inline highlighting, or an annotation framework, this decision should be revisited.

## Second Attempt (2026-03-06): Adopted then Reverted

The original rejection reasons had changed — Shiki was already running client-side in a web worker, and the custom diff code had grown to ~950 lines. A migration was attempted. It was reverted after encountering multiple issues:

### Hunk expansion requires full file contents upfront

The library's expansion model assumes all file contents are available at parse time (via `parseDiffFromFile`). REINS streams diffs from `git diff` output and doesn't have full file contents loaded. Attempting lazy one-off loading for expansion (fetching file contents on demand when the user clicks "expand") didn't work well — the library doesn't support injecting file contents after initial parse, so workarounds were fragile and complex.

### Rendering performance was worse

Significant performance regressions on both mobile and desktop. The `FileDiff` component's rendering was noticeably slower than the existing custom Shiki-in-worker implementation, particularly for large diffs. The cause wasn't fully diagnosed, but the custom implementation — which highlights in a web worker pool and renders simple HTML — didn't have these issues.

### Net code increase, not decrease

The migration was supposed to eliminate ~950 lines of custom code. Instead, the workarounds for expansion, render batching, height estimation, and performance mitigations grew `diff-panel.ts` from 685 to 1,031 lines — a 50% increase. The complexity shifted rather than decreased.

### Didn't get to use the features we wanted

The issues above consumed all the migration effort, so the features that motivated the attempt (annotations, word-level inline diffs) were never actually integrated. Those will need to be built into the custom implementation instead.

## Final Decision

**Rejected.** Keep the custom diff implementation. Build desired features (annotations, inline word-level diffs) directly rather than adopting this library. The expansion model and rendering performance are fundamental mismatches with REINS's architecture.

Do not revisit this decision unless `@pierre/diffs` adds support for lazy/on-demand file content loading for hunk expansion.
