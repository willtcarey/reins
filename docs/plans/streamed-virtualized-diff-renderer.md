# Virtualized Diff Renderer Direction

## Goal

Build a future Changes renderer that keeps the performance benefits demonstrated by `@pierre/diffs` while preserving Reins review behavior: selected-session branch scoping, file tree navigation, hunk expansion, file actions, markdown/image/PDF previews, and future mixed review content.

The current CodeView renderer prototype proved an important point: **most of the immediate performance win comes from Pierre's `CodeView` top-level virtualization, not from streaming the raw patch.** That changes the next implementation direction.

## Current status and decision

The `diff_renderer` setting now uses `codeview` for the direct Pierre `CodeView` proof point that fetches `/diff/patch` as full text, parses it with `@pierre/diffs`, and mounts Pierre `CodeView`. Classic remains the default, so non-default renderer access is controlled by the stored preference rather than frontend dev-mode gating.

The direct CodeView diff implementation is complete enough as a proof point. A future implementation step may add a separate Reins-owned virtualized renderer path and compare it against `codeview` while keeping `classic` as the default.

In particular:

- Do not continue polishing direct `CodeView` as if it were the final architecture.
- Do not prioritize streaming/chunked patch loading before replacing the `CodeView`-owned surface.
- Do not build core behavior on deprecated `hunkSeparators(hunkData, instance)` APIs.
- Do not switch back to the old `/diff` JSON endpoint for Pierre rendering unless there is a specific reason; raw patch maps naturally to `@pierre/diffs` metadata.

## New direction

Build a Reins-owned virtual review surface that uses lower-level Pierre primitives where they help, while Reins owns the mixed-content layout and interaction model.

Target architecture:

```txt
GET /api/projects/:id/diff/patch as full text initially
  → DiffStore fetches raw patch text with active diff params
  → renderer-specific components parse with @pierre/diffs parsePatchFiles/processFile
  → store renderer-specific virtual item records outside DiffStore.fullData
  → render through a Reins-owned top-level virtual list
       ├─ code diff item: Pierre VirtualizedFileDiff/FileDiff pieces
       ├─ markdown preview item/panel: Reins renderer
       ├─ image/PDF/binary preview item/panel: Reins renderer
       ├─ file actions/header controls: Reins renderer
       └─ future annotations/comments/actions: Reins renderer
```

The key requirement is that the Reins-owned surface must be **CodeView-like**, not merely Pierre `Virtualizer` wrapped around thousands of mounted file containers. `CodeView` is fast because it keeps item records/heights for all files but only mounts DOM containers for the visible window plus overscan. The lower-level `Virtualizer` is more flexible but generally mounts every top-level file/diff container, which gives back a large part of the many-file performance win.

## Prototype findings to preserve

- `CodeView` validates that top-level item virtualization, DOM pooling, estimated heights, and worker-backed highlighting are the performance-critical pieces.
- Full-patch fetch is acceptable for now. Streaming likely helps time-to-first-file on huge diffs but is not required for the next architectural decision.
- Raw patch parsing produces `FileDiffMetadata.isPartial === true`; Pierre native hunk expansion is unavailable until old/new file contents are available.
- Seamless lazy expansion requires Reins to show expansion affordances before contents are fetched, then fetch contents on first click and update the rendered item.
- Direct `CodeView` does not expose a clean public async hunk-expansion interception hook. Lower-level/custom separator escape hatches exist but are deprecated or unsupported for core behavior.

## Implementation checklist

### Current proof point

- [x] Settings groundwork: persist `diff_renderer`, default to `classic`, expose the control in Settings, and cover it with tests.
- [ ] If/when a Reins-owned virtualized renderer is built, expand `diff_renderer` beyond `classic` and `codeview`.
- [x] Add the raw patch backend path with existing diff branch/mode/context semantics.
- [x] Add the renderer prototype that consumes the `/diff/patch` streaming diff.
- [x] Mount Pierre `CodeView` in the prototype path to validate performance characteristics; this becomes the `codeview` renderer value.

### Build the next virtualized implementation

- [ ] Treat the existing `codeview` renderer as completed proof-of-concept work.
- [ ] Add a separate renderer value backed by a Reins-owned top-level virtual list.
- [ ] Keep `codeview` available as the comparison baseline while building it.
- [ ] Document the CodeView diff prototype compatibility gaps clearly in the plan/results.
- [ ] Design a Reins-owned top-level virtual list with CodeView-like behavior:
  - item records for all files/content blocks
  - estimated heights and measured height corrections
  - visible-window DOM mounting only
  - DOM element pooling or recycling
  - scroll anchoring for item updates and expansion
  - active-file scroll spy hooks
  - sticky or pinned file headers if needed
- [ ] Define virtual item types for mixed review content:
  - `diff`
  - `markdown-preview` / markdown tab state
  - `binary-placeholder`
  - `image-preview`
  - `pdf-preview`
  - future comments/annotations/actions
- [ ] Integrate Pierre lower-level rendering for code diff items without making Pierre own the whole review surface.
- [ ] Keep classic renderer as the production default until parity decisions are resolved.

### Data and parsing

- [ ] Keep full `/diff/patch` loading for the first Reins-owned renderer spike.
- [ ] Continue parsing raw patches into `FileDiffMetadata` with stable cache keys.
- [x] Consume raw `/diff/patch` text through `DiffStore` with the active branch/session, diff mode, and context-line semantics.
- [ ] Preserve selected branch/session scoping, diff modes, and context-line semantics.
- [ ] Defer streaming/file chunking until after the Reins-owned virtual surface demonstrates comparable performance.

### Lazy hunk expansion

- [ ] Add a backend endpoint to fetch the old/new file contents for one diff file using diff semantics, not simple branch-file reads.
- [ ] On initial raw patch render, show Reins-owned expansion affordances for hidden context even though the item is partial.
- [ ] On first expansion click for a partial file:
  1. show loading state on the clicked control
  2. fetch old/new contents for the file
  3. reprocess that file patch with `processFile(filePatch, { oldFile, newFile })`
  4. update the virtual item and height estimate
  5. apply the requested expansion
  6. preserve scroll anchoring
- [ ] After a file is promoted to full-content metadata, allow further expansion without refetching.
- [ ] Define fallback behavior for files that cannot be promoted: binary files, deleted/new/untracked edge cases, missing refs, parser errors, and size limits.

The per-file content endpoint should understand:

- branch mode for active checked-out branch: old side is merge-base, new side is working tree/index state as appropriate
- branch mode for non-active selected branch: old side is merge-base, new side is selected branch commit
- uncommitted mode: old side is `HEAD`, new side is working tree/index state
- renames: old path may be `prevName`, new path may be `name`
- new/deleted files: one side may be absent
- untracked files: old side absent, new side working tree content

Suggested response shape:

```ts
type DiffFileContentsResponse = {
  oldFile?: { name: string; contents: string; cacheKey?: string };
  newFile?: { name: string; contents: string; cacheKey?: string };
};
```

## Proposed phases

### Phase 1 — Build the future virtualized renderer

Add a new renderer value for the Reins-owned virtualized renderer path. Keep `diff_renderer = "codeview"` pointing at the existing direct Pierre `CodeView` proof point for comparison.

Build the smallest Reins-owned top-level virtual list that does not mount every file container.

Requirements:

- accepts a list of virtual item records with estimated heights
- mounts only visible/overscan DOM nodes
- supports scroll-to-item by ID
- reports active item/file
- supports item height changes without losing scroll position
- can render placeholder/custom HTML items before integrating diff rendering
- preserves the renderer setting and full `/diff/patch` data path

This phase answers whether Reins can reproduce enough of `CodeView`'s top-level virtualization behavior while keeping ownership of mixed review layout.

### Phase 2 — Diff item integration

Render `diff` items using Pierre lower-level primitives, likely `VirtualizedFileDiff`/`FileDiff` plus the shared `WorkerPoolManager`.

Requirements:

- render parsed `FileDiffMetadata`
- use stable cache keys for worker/highlight reuse
- avoid eager highlighting outside the visible window
- support collapsed file items
- preserve file header actions through Reins-owned header UI

### Phase 3 — Mixed review content

Add non-code review content that direct `CodeView` cannot own cleanly:

- markdown diff/preview tabs
- image previews
- PDF previews
- binary placeholders
- copy path / download / open in browser actions
- future comments/annotations/actions

### Phase 4 — Lazy expansion

Implement the per-file old/new content endpoint and first-click promotion flow.

The user experience should match classic Reins behavior: expansion controls are visible before content is fetched, and clicking one fetches and expands seamlessly.

### Phase 5 — Measurement and parity pass

Compare against classic and the previous direct `CodeView` baseline:

- time to first visible diff
- mounted DOM node count
- many-file scroll responsiveness
- large-single-file behavior
- memory growth
- hunk expansion responsiveness
- file tree/active-file correctness

Only after this pass decide whether streaming chunking is still worth implementing.

### Phase 6 — Optional streaming/chunking

If measurements show full-patch fetch/parse is a bottleneck, add streaming later:

```txt
raw patch stream
  → frame complete file patches
  → processFile(filePatch)
  → append virtual item records in batches
```

Streaming remains an optimization, not the foundation of the architecture.

## Compatibility gaps to track

| Area | `codeview` prototype | Future virtualized direction |
|---|---|---|
| Large diffs | Good proof point from CodeView | Must match with Reins-owned top-level virtual list |
| Selected branch/session scoping | Preserved via `/diff/patch` params | Preserve |
| Diff modes | Preserved | Preserve |
| File tree navigation | Basic integration | First-class scroll-to-item and active-file state |
| Hunk expansion | Unsupported for partial raw patches | Reins-owned first-click lazy promotion |
| Markdown preview | Deferred | First-class mixed item/tab support |
| Image/PDF previews | Deferred | First-class mixed item/tab support |
| Binary files | Limited/metadata only | Reins-owned placeholders/previews |
| File actions | Re-added through CodeView header hooks | Reins-owned header/action UI |
| Renames | Parser metadata available; verify UI | Preserve old/new path handling for expansion |
| Untracked files | Raw patch support exists; verify | Preserve and support one-sided content fetch |
| Inline word diff | Pierre default behavior; evaluate | Evaluate after diff item integration |
| Streaming | Deferred | Optional later optimization |

## Testing and measurement

Follow red/green/refactor for implementation work.

Suggested tests:

- backend raw patch endpoint preserves mode/branch/context query semantics
- per-file diff content endpoint returns correct old/new sides for branch, non-active branch, and uncommitted modes
- per-file content endpoint handles rename/new/deleted/untracked files
- virtual item model creates stable IDs/cache keys
- top-level virtual list mounts only visible/overscan items
- scroll-to-item works without all item DOM mounted
- item height updates preserve scroll anchor
- lazy hunk expansion promotes one file and applies requested expansion
- renderer setting selects `classic`, `codeview`, and the future virtualized path while classic remains default

Suggested manual/performance fixtures:

- small normal diff
- many small files
- one very large file
- mixed rename/change/delete/new files
- binary file diff
- markdown file
- image/PDF file
- untracked file

Metrics to capture:

- time to first row/file visible
- total parse time
- mounted item/container count
- total DOM nodes
- scroll FPS/subjective responsiveness
- expansion click latency before/after promotion
- memory growth for large diffs
- comparison against classic renderer and the `codeview` prototype

## Done criteria for the next architecture slice

- Reins-owned virtual list proves it can avoid mounting every file container.
- It can render at least basic Pierre-backed diff items from raw patch metadata.
- File tree navigation works without all item DOM mounted.
- The design supports mixed Reins review content without relying on deprecated Pierre APIs.
- Lazy expansion has a concrete endpoint/model plan, even if not fully implemented in the first slice.
- Classic remains stable and default.
