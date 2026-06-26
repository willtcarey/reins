# Streamed Virtualized Diff Renderer Prototype

## Goal

Prototype a new Changes diff rendering path optimized for very large diffs by adopting the `@pierre/diffs` pieces and architecture that make DiffsHub performant, without doing another direct `FileDiff` drop-in replacement.

Reference: <https://diffshub.com/oven-sh/bun/pull/30412>

The prototype should be selectable from Settings and should preserve current Reins review behavior where practical: selected-session branch scoping, file tree navigation, diff modes, and hunk behavior. Compatibility gaps should be documented explicitly.

## Current direction

Use a parallel renderer path:

- **Classic** — current Reins diff renderer, default behavior.
- **Virtualized prototype** — new streamed/virtualized renderer backed by raw git patch input and selected `@pierre/diffs` primitives.

A persisted `diff_renderer` setting has been added with values:

- `classic`
- `virtual`

The setting is not wired to the diff panel yet. Its UI is included only in dev builds (`REINS_DEV=true` as a frontend build constant, matching the backend `process.env.REINS_DEV`) so this work can land across multiple PRs without exposing or shipping a no-op preference in production builds.

## Key architectural decision

Do **not** directly adopt `FileDiff` as the top-level replacement.

Instead, adopt the DiffsHub-style architecture:

```txt
git diff raw patch stream
  → split into complete file diff chunks
  → parse each file chunk with @pierre/diffs processFile(...)
  → append parsed file items into a virtualized CodeView-style surface
```

Useful `@pierre/diffs` APIs/pieces to evaluate:

- `processFile(fileDiffString, { cacheKey, isGitDiff: true })`
- `parsePatchFiles(...)` as a fallback/full-patch parser
- `FileDiffMetadata`
- `CodeView`
- `CodeViewHandle`
- `CodeViewItem` / `CodeViewDiffItem`
- `VirtualFileMetrics`
- worker/highlight cache pieces keyed by `FileDiffMetadata.cacheKey`

## Why this differs from prior rejected attempts

ADR-001 rejected direct `@pierre/diffs` adoption because `FileDiff` was slower, complicated hunk expansion, and increased code. This plan revisits the library for a different reason: DiffsHub demonstrates a performant architecture based on streaming file chunks, imperative append/update APIs, virtualization, measured height caches, and worker-backed highlighting.

The goal is to adopt those pieces/patterns, not repeat the previous `FileDiff` migration.

## Proposed implementation phases

### Phase 1 — Raw patch endpoint

Add a backend endpoint that returns raw unified git patch text using the same semantics as the current diff endpoints:

```txt
GET /api/projects/:id/diff/patch?context=3&mode=branch&branch=...
Content-Type: text/x-diff
```

It should preserve:

- selected task branch vs base branch
- scratch session fallback to HEAD
- `branch` vs `uncommitted` diff modes
- context-line parameter

Initial implementation can stream `git diff` stdout directly. Untracked synthetic diffs can either be appended or documented as a prototype limitation if that simplifies the first slice.

### Phase 2 — Stream/file chunking layer

Implement a small streaming splitter that frames raw patch text into complete file-diff chunks.

Important: this is **not** a diff parser. It only finds safe boundaries, likely around `diff --git ...` records, and then passes each complete chunk to `@pierre/diffs`.

Use:

```ts
processFile(filePatch, {
  cacheKey,
  isGitDiff: true,
});
```

Fallback path:

```ts
parsePatchFiles(fullPatch);
```

for cases where streaming chunking fails or for simpler first tests.

### Phase 3 — Virtual diff store/model

Create a renderer-specific data model separate from the existing `DiffStore.fullData` JSON path.

Suggested item shape:

```ts
type VirtualDiffItem = {
  id: string;
  type: "diff";
  fileDiff: FileDiffMetadata;
  version: number;
  collapsed?: boolean;
};
```

Track separately:

- `itemIdToFile`
- `pathToItemId`
- file summaries/stats
- parse/loading status
- streamed item count
- stable cache keys
- measured height cache

Use deterministic, collision-safe IDs based on file path and occurrence.

### Phase 4 — Virtual renderer

Build a new virtualized diff component path, e.g.

```txt
<virtual-diff-panel>
```

Preferred experiment: use `@pierre/diffs` `CodeView` directly or wrap it thinly. If direct use is too awkward in Lit, reproduce the same architecture with a Reins-owned virtualizer while still using `processFile` / `FileDiffMetadata`.

Renderer requirements:

- append files incrementally as they parse
- avoid routing every streamed update through large reactive arrays
- use imperative append/update APIs where possible
- maintain file selection/scroll target behavior
- support collapsed files
- avoid rendering/highlighting the entire diff up front

### Phase 5 — Wire setting to renderer selection

Once the virtual renderer can show basic parsed diffs, wire the existing setting:

```ts
diff_renderer === "virtual"
  ? html`<virtual-diff-panel ...>`
  : html`<classic-diff-panel ...>`
```

Classic remains default and fallback.

### Phase 6 — File tree and scroll behavior

Preserve the current file tree UX:

- file tree uses lightweight `/diff/files` data initially
- clicking a file scrolls the virtual renderer to that file item
- visible item updates active file highlighting
- if a clicked file is collapsed, expand it before scrolling

Use `CodeView` scroll targets if adopting `CodeView` directly:

```ts
scrollTo({ type: "item", id, align: "start", behavior: "smooth" });
```

### Phase 7 — Highlighting and worker/cache strategy

Use stable `cacheKey` values on each `FileDiffMetadata` so the library worker/cache can reuse highlighted output.

Prototype should measure:

- time to first visible diff
- time to first N parsed files
- total parse time
- total render time
- scroll responsiveness
- number of mounted DOM nodes/items

Avoid eagerly highlighting every streamed file. Prefer visible/near-visible work where possible.

### Phase 8 — Hunk expansion strategy

Raw patch parsing produces partial file metadata (`isPartial: true`). In this mode, library-native hunk expansion is unavailable because full old/new file contents are not present.

Prototype options:

1. Document hunk expansion as unsupported in virtual mode initially.
2. Preserve Reins-style lazy expansion by fetching file contents on demand and injecting extra rows/items ourselves.
3. Later evaluate a full-content path for selected files only.

The first prototype can ship with option 1 if performance evaluation is the priority, but the compatibility gap must be visible in the plan/results.

## Compatibility gaps to document

Track each area explicitly during the prototype:

| Area | Expected prototype status |
|---|---|
| Large diffs | Primary success criterion |
| Selected branch/session scoping | Preserve |
| Diff modes | Preserve |
| File tree navigation | Preserve |
| Active file scroll spy | Preserve if practical |
| Hunk expansion | Likely limited/unsupported at first |
| Syntax highlighting | Use library worker/cache; measure carefully |
| Renames | Parser supports metadata; verify UI behavior |
| Binary files | Likely metadata-only rows/placeholders |
| Untracked files | Verify synthetic diff compatibility |
| Markdown preview | Defer or bridge separately |
| Image/PDF previews | Defer or bridge separately |
| Copy/download/open-file actions | Re-add in virtual file headers if practical |
| Inline word diff | Evaluate after basic renderer works |

## Testing and measurement

Follow red/green/refactor for implementation.

Suggested tests:

- backend raw patch endpoint preserves mode/branch/context query semantics
- streaming chunker frames multiple files correctly
- chunker handles renames/binaries/no-newline markers enough to pass to `processFile`
- virtual diff store appends parsed items with stable IDs/cache keys
- renderer setting selects classic/virtual path once wired
- file tree scroll target resolves to item ID

Suggested manual/performance fixtures:

- small normal diff
- many small files
- one very large file
- mixed rename/change/delete/new files
- binary file diff
- markdown file
- untracked file

Metrics to capture:

- time to first row/file visible
- total files parsed
- total lines parsed/rendered
- total mounted items/DOM nodes
- scroll FPS/subjective responsiveness
- memory growth for large diffs
- comparison against classic renderer

## Done criteria for prototype

- Setting can switch between classic and virtual renderer.
- Virtual renderer can load a raw patch for the selected session/project.
- Large diffs render progressively or substantially faster than classic.
- File tree navigation works for parsed files.
- Compatibility gaps are documented with clear follow-up decisions.
- Classic renderer remains stable and default.
