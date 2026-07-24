# Virtualized Diff Renderer Direction

## Goal

Build a future Changes renderer that keeps the performance benefits demonstrated by `@pierre/diffs` while preserving Reins review behavior: selected-session branch scoping, file tree navigation, fluid inline context expansion, file actions, markdown/image/PDF previews, and future mixed review content.

## Implementation plan

This is the working implementation list. It is ordered from smallest functional scaffold to performance-critical architecture. Keep `classic` as the default throughout, and keep `codeview` available as the performance comparison baseline.

### Already done

- [x] Add and persist `diff_renderer` with `classic` as the default.
- [x] Add the raw patch endpoint and `DiffStore` raw patch loading path with active branch/session, diff mode, and context-line semantics.
- [x] Add the direct Pierre `CodeView` proof point as `diff_renderer = "codeview"`.
- [x] Verify the `codeview` proof point demonstrates the key performance lesson: top-level item virtualization matters more immediately than raw patch streaming.

### Next incremental steps

1. [ ] **Add the Reins-owned renderer shell.**
   - Add `diff_renderer = "virtualized"` for the future Reins-owned path.
   - Route the setting to a placeholder panel without changing `classic` or `codeview`.
   - Keep the `virtualized` shell behind the renderer setting; it does not need production parity yet.

2. [ ] **Create renderer-specific review item records.**
   - Parse the already-loaded raw patch into Reins-owned item records.
   - Use stable item IDs and cache keys from path/old path/status/occurrence.
   - Keep this state separate from `DiffStore.fullData`.
   - Define item-level state by ID: collapsed/expanded, active tab, parse errors, later height cache.

3. [ ] **Build the non-virtual functional scaffold with worker-backed highlighting.**
   - Render `items.map(renderItem)` initially.
   - Render Reins-owned file headers and basic file actions.
   - Render basic diff bodies using Pierre pieces where practical.
   - Use Pierre worker-pool/highlight-cache primitives from the start so syntax highlighting does not run on the main thread.
   - Keep stable cache keys wired through the scaffold so worker-highlight output can be reused after virtualization lands.
   - Add `scrollToItem(id)` and active-item callback abstractions even if implemented with mounted DOM queries at first.
   - Document in-code/plan that this scaffold may mount every file and is not a performance prototype.

4. [ ] **Add file tree integration against item IDs.**
   - File tree clicks resolve to review item IDs.
   - `scrollToItem(id)` works in the scaffold.
   - Active file state is reported through the abstraction instead of depending on all files being permanently mounted.

5. [ ] **Add Reins-owned behavior that `CodeView` cannot own cleanly.**
   - Collapsed file state.
   - Copy path / download / open in browser actions.
   - Markdown diff/preview tabs.
   - Image previews, PDF previews, and binary placeholders.
   - Reserve slots for future comments/annotations/actions.

6. [ ] **Replace top-level mounting with a CodeView-like virtual list.**
   - Swap `items.map(renderItem)` for a Reins-owned virtual list.
   - Keep item records for all files in JS, but mount only visible/overscan item DOM.
   - Render no offscreen file wrapper/placeholder DOM.
   - Support scroll-to-item by ID without all item DOM mounted.
   - Track estimated/measured heights and preserve scroll position on height changes.
   - Add DOM pooling/recycling only if simple mount/unmount is not enough.

7. [ ] **Adapt diff rendering/highlighting to the virtualized path.**
   - Render parsed `FileDiffMetadata` in visible `diff` items.
   - Reuse the scaffold's worker-pool/highlight-cache integration.
   - Avoid scheduling highlight work for items outside the visible/overscan window.
   - Preserve Reins-owned headers/actions around the Pierre-rendered diff body.

8. [ ] **Implement fluid inline context expansion.**
   - Treat each diff as a view into the complete file, with collapsed unchanged regions appearing naturally between hunks.
   - Let the user reveal more lines directly in place; repeated expansion should continue opening the region until adjacent hunks join or the complete file is visible.
   - Keep the interaction continuous: the file must not visibly switch modes, disappear, or be replaced while content is acquired.
   - Add the per-file old/new content endpoint with diff semantics and retrieve complete contents invisibly on the first expansion when they are not already available.
   - Update rendered lines and measured item height while anchoring the touched region in the viewport so expansion does not disorient the user.
   - Consider prefetching likely expansion data where it meaningfully reduces first-interaction latency without loading every complete file eagerly.
   - If complete content cannot be retrieved, leave the existing partial diff stable and show a non-disruptive error at the expansion control.

9. [ ] **Measure and compare.**
   - Compare `classic`, `codeview`, and the Reins-owned virtual path.
   - Capture time to first visible diff, mounted item/container count, total DOM nodes, scroll responsiveness, memory growth, and expansion latency.
   - Only after this pass decide whether streaming/chunking is still worth implementing.

10. [ ] **Optionally add streaming/chunking later.**
    - If full-patch fetch/parse is a bottleneck, frame complete file patches from the raw stream and append item records in batches.
    - Treat streaming as an optimization, not the foundation of the renderer architecture.

The current CodeView renderer prototype proved an important point: **most of the immediate performance win comes from Pierre's `CodeView` top-level virtualization, not from streaming the raw patch.** That changes the next implementation direction.

## Current status and decision

The `diff_renderer` setting now uses `codeview` for the direct Pierre `CodeView` proof point that fetches `/diff/patch` as full text, parses it with `@pierre/diffs`, and mounts Pierre `CodeView`. Classic remains the default, so non-default renderer access is controlled by the stored preference rather than frontend dev-mode gating.

The direct CodeView diff implementation is complete enough as a proof point. The next renderer value will be `virtualized`: a separate Reins-owned virtualized renderer path compared against `codeview` while keeping `classic` as the default.

In particular:

- Do not continue polishing direct `CodeView` as if it were the final architecture.
- Do not prioritize streaming/chunked patch loading before replacing the `CodeView`-owned surface.
- Do not build core behavior on deprecated `hunkSeparators(hunkData, instance)` APIs.
- Do not switch back to the old `/diff` JSON endpoint for Pierre rendering unless there is a specific reason; raw patch maps naturally to `@pierre/diffs` metadata.

## New direction

Build a Reins-owned review surface that uses lower-level Pierre primitives where they help, while Reins owns the mixed-content layout and interaction model. Implement it incrementally: start with a non-virtual functional scaffold behind a non-default renderer setting, then replace the top-level mounting strategy with a CodeView-like virtual list once the item model and interactions are proven.

Target final architecture:

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

The key requirement for the eventual performance path is that the Reins-owned surface must be **CodeView-like**, not merely Pierre `Virtualizer` wrapped around thousands of mounted file containers. `CodeView` is fast because it keeps item records/heights for all files but only mounts DOM containers for the visible window plus overscan. The lower-level `Virtualizer` is more flexible but generally mounts every top-level file/diff container, which gives back a large part of the many-file performance win.

Because `classic` and `codeview` remain available fallbacks, the first Reins-owned implementation may render non-virtually to get behavior and layout working sooner. That scaffold must keep a clean item-model boundary so virtualization can replace `items.map(renderItem)` later without redesigning interactions:

```ts
type ReviewItem = { id: string; kind: "diff" | "markdown-preview" | "image-preview" | "pdf-preview" | "binary-placeholder" };

renderItem(item: ReviewItem): TemplateResult;
scrollToItem(id: string): void;
onActiveItemChange(id: string): void;
```

The non-virtual scaffold is **not** a performance prototype. It should be used only to validate Reins-owned headers/actions, mixed content, parsing, and interaction boundaries. Performance evaluation waits until the top-level list mounts only visible/overscan item DOM.

## Prototype findings to preserve

- `CodeView` validates that top-level item virtualization, DOM pooling, estimated heights, and worker-backed highlighting are the performance-critical pieces.
- `CodeView` worked because it did not render DOM placeholders/wrappers for every diff file. Rendering every top-level file container, even with virtualized bodies inside each file, loses the primary many-file win.
- Full-patch fetch is acceptable for now. Streaming likely helps time-to-first-file on huge diffs but is not required for the next architectural decision.
- Worker-backed syntax highlighting is required even in the non-virtual scaffold; main-thread highlighting can make the scaffold unusable before top-level virtualization is added.
- Raw patch parsing produces `FileDiffMetadata.isPartial === true`; complete old/new file contents are still required to reveal unchanged lines that are absent from the patch.
- Content retrieval is an internal detail, not a user-visible transition. The collapsed region should remain the stable interaction point while complete contents are acquired, then open inline without replacing the file surface.
- Direct `CodeView` does not expose a clean public async context-expansion interception hook. Lower-level/custom separator escape hatches exist but are deprecated or unsupported for core behavior.

## Detailed design notes

### Renderer item boundary

The Reins-owned path should keep behavior behind item IDs from the start, even while the first scaffold is non-virtual:

```ts
type ReviewItem = {
  id: string;
  kind: "diff" | "markdown-preview" | "image-preview" | "pdf-preview" | "binary-placeholder";
};

renderItem(item: ReviewItem): TemplateResult;
scrollToItem(id: string): void;
onActiveItemChange(id: string): void;
```

The point is to make the later virtualization change a mounting-strategy swap rather than a rewrite of parsing, file tree navigation, actions, or preview state.

### Fluid inline context expansion

The interaction contract is that a diff behaves like a window into the complete file. Collapsed unchanged regions sit between visible hunks, and activating one reveals additional lines in that same position. Repeated activation can continue opening context until regions meet. Fetching complete file contents, rebuilding internal diff metadata, and updating virtual measurements must remain invisible implementation details; there is no separate “expanded mode” and no user-visible replacement of the file item.

The line or collapsed region the user acts on should remain visually anchored while its surrounding content opens. The renderer should update item height and compensate scroll position as needed rather than allowing content above the interaction point to push it away.

To support this behavior, the per-file content endpoint should understand:

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

### Optional streaming/chunking shape

If measurements show full-patch fetch/parse is a bottleneck, add streaming later:

```txt
raw patch stream
  → frame complete file patches
  → processFile(filePatch)
  → append virtual item records in batches
```

## Compatibility gaps to track

| Area | `codeview` prototype | Future virtualized direction |
|---|---|---|
| Large diffs | Good proof point from CodeView | Must match with Reins-owned top-level virtual list |
| Selected branch/session scoping | Preserved via `/diff/patch` params | Preserve |
| Diff modes | Preserved | Preserve |
| File tree navigation | Basic integration | First-class scroll-to-item and active-file state |
| Context expansion | Unsupported for partial raw patches | Fluid in-place reveal backed by invisible lazy content retrieval |
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
- first context expansion retrieves missing content and reveals lines without replacing the file surface
- repeated context expansion joins adjacent regions while preserving the interaction point's viewport position
- failed content retrieval leaves the partial diff stable and reports the error at the expansion control
- renderer setting selects `classic`, `codeview`, and `virtualized` while classic remains default

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
- first and subsequent inline expansion latency
- memory growth for large diffs
- comparison against classic renderer and the `codeview` prototype

## Done criteria for the next architecture slice

- Reins-owned virtual list proves it can avoid mounting every file container.
- It can render at least basic Pierre-backed diff items from raw patch metadata.
- File tree navigation works without all item DOM mounted.
- The design supports mixed Reins review content without relying on deprecated Pierre APIs.
- Fluid inline context expansion has a concrete endpoint, item-state, and scroll-anchoring plan, even if not fully implemented in the first slice.
- Classic remains stable and default.
