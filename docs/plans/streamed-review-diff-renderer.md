# Review Diff Renderer Direction

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

1. [x] **Add the Reins-owned renderer shell.**
   - Add `diff_renderer = "virtualized"` for the future Reins-owned path.
   - Route the setting to a placeholder panel without changing `classic` or `codeview`.
   - Keep the review shell behind the `virtualized` renderer setting; it does not need production parity yet.

2. [x] **Create renderer-specific review item records.**
   - Parse the already-loaded raw patch into Reins-owned item records.
   - Use stable item IDs from path/old path/status/occurrence, and reconcile file-level content fingerprints so unchanged records and cache keys survive a refreshed patch.
   - Keep this state separate from `DiffStore.fullData`.
   - Define item-level state by ID: collapsed/expanded, active tab, parse errors, later height cache.

3. [x] **Build the non-virtual functional scaffold with worker-backed highlighting.**
   - Render `items.map(renderItem)` initially.
   - Render the minimum Reins-owned file header; collapse and richer actions remain deferred with the other Reins-owned behavior below.
   - Render basic diff bodies using Pierre pieces where practical.
   - Use Pierre worker-pool/highlight-cache primitives from the start so syntax highlighting does not run on the main thread.
   - Keep stable cache keys wired through the scaffold so worker-highlight output can be reused after virtualization lands.
   - Add item-ID navigation and active-item reporting seams, initially backed by mounted DOM queries.
   - Document in-code/plan that this scaffold may mount every file and is not a performance prototype.

4. [x] **Add file tree integration against item IDs.**
   - File tree clicks resolve to review item IDs.
   - Item-ID navigation works in the scaffold.
   - Active file state is reported through the abstraction instead of depending on all files being permanently mounted.

5. [ ] **Add Reins-owned behavior that `CodeView` cannot own cleanly.**
   - [x] Collapsed file state.
   - [x] Copy path / download / open in browser actions.
   - Markdown diff/preview tabs.
   - Image previews, PDF previews, and binary placeholders.
   - Reserve slots for future comments/annotations/actions.

6. [x] **Replace top-level mounting with a CodeView-like virtual list.**
   - [x] Swap all-item rendering for a bounded visible/overscan window.
   - [x] Keep item records for all files in JS, but mount only visible/overscan item DOM.
   - [x] Render no offscreen file wrapper/placeholder DOM.
   - [x] Support file-tree navigation by item ID without the target DOM being mounted.
   - [x] Track estimated/measured heights and preserve scroll position on height changes.
   - DOM pooling/recycling remains deferred; simple keyed mount/unmount is the chosen first implementation.

7. [x] **Adapt diff rendering/highlighting to the review path.**
   - [x] Render parsed `FileDiffMetadata` in mounted `diff` items.
   - [x] Reuse the scaffold's worker-pool/highlight-cache integration.
   - [x] Avoid scheduling highlight work for items outside the visible/overscan window by not constructing their item components.
   - [x] Preserve Reins-owned headers/actions around the Pierre-rendered diff body.

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

The `diff_renderer` setting supports `codeview` for the direct Pierre `CodeView` proof point and `virtualized` for the Reins-owned review surface. Both fetch `/diff/patch` as full text. The Reins-owned path parses renderer-specific review records, owns the file headers and item-ID navigation contract, and delegates text rows and worker-backed highlighting to Pierre `FileDiff`. Classic remains the default, so non-default renderer access is controlled by the stored preference rather than frontend dev-mode gating.

The `virtualized` renderer now keeps all review records in JavaScript while one persistent Reins-owned coordinator mounts only a balanced viewport/overscan window. Its Reins-owned headers include accessible collapse controls plus the shared view, copy-path, and download actions. A collapsed item records the hash of that exact reviewed diff in local storage under its project, branch, and stable item ID; both diff modes share that reviewed state. Matching content remains collapsed across reconciliation, project switches, and reloads; changed content expands and invalidates the marker so a later revert also stays expanded. File-tree navigation resolves coordinator geometry and therefore works before the target wrapper exists. Active-file tracking uses that same geometry. Stable measurements are retained by item/content/render-state key and committed in batches against a semantic item plus viewport-offset anchor. Absolutely positioned wrappers in a fixed-total-height container prevent asynchronous sizing from moving siblings before the post-render scroll reconciliation. Balanced overscan supports reverse scrolling, while explicit input cancellation prevents smooth navigation and anchor correction from fighting touch, wheel, pointer, or keyboard scrolling. Context expansion, per-file content retrieval, rich previews, pooling, patch streaming, and performance measurement remain follow-up work.

In particular:

- Do not continue polishing direct `CodeView` as if it were the final architecture.
- Do not prioritize streaming/chunked patch loading before replacing the `CodeView`-owned surface.
- Do not build core behavior on deprecated `hunkSeparators(hunkData, instance)` APIs.
- Do not switch back to the old `/diff` JSON endpoint for Pierre rendering unless there is a specific reason; raw patch maps naturally to `@pierre/diffs` metadata.

## New direction

Build a Reins-owned review surface that uses lower-level Pierre primitives where they help, while Reins owns the mixed-content layout and interaction model. The non-virtual functional scaffold established the interaction model; the current slice replaces its mounting strategy with a CodeView-like bounded virtual window.

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

Because `classic` and `codeview` remain available fallbacks, the Reins-owned path was first built non-virtually to validate behavior. That scaffold has now been replaced: `ReviewDiffPanel` derives virtual geometry from the stable renderer-owned item records and mounts only a viewport/overscan slice. The panel retains navigation, active-item, and collapse coordination rather than introducing a second stateful virtualizer lifecycle. Performance evaluation can now use this bounded mounting path.

## Prototype findings to preserve

- `CodeView` validates that top-level item virtualization, DOM pooling, estimated heights, and worker-backed highlighting are the performance-critical pieces.
- `CodeView` worked because it did not render DOM placeholders/wrappers for every diff file. Rendering every top-level file container, even with virtualized bodies inside each file, loses the primary many-file win.
- Full-patch fetch is acceptable for now. Streaming likely helps time-to-first-file on huge diffs but is not required for the next architectural decision.
- Worker-backed syntax highlighting is required even in the non-virtual scaffold; main-thread highlighting can make the scaffold unusable before top-level virtualization is added.
- Raw patch parsing produces `FileDiffMetadata.isPartial === true`; complete old/new file contents are still required to reveal unchanged lines that are absent from the patch.
- Content retrieval is an internal detail, not a user-visible transition. The collapsed region should remain the stable interaction point while complete contents are acquired, then open inline without replacing the file surface.
- Direct `CodeView` does not expose a clean public async context-expansion interception hook. Lower-level/custom separator escape hatches exist but are deprecated or unsupported for core behavior.

## Detailed design notes

### Chosen virtual layout seam

`review-virtual-layout.ts` now exposes one persistent `ReviewVirtualCoordinator` rather than a collection of stateless prefix-layout helpers. Stable `ReviewItem` IDs remain the source of identity, while a measurement key adds project, branch, content, and collapsed/expanded state so valid dimensions persist and stale dimensions naturally stop applying. Initial heights still use Pierre's 20px row metric, each hunk's exact `unifiedLineCount`, line-info separator geometry, no-newline metadata rows, the Reins header, and in-box inter-file spacing.

The coordinator owns all top-level geometry, viewport state, balanced pixel overscan, active-item lookup, and unmounted navigation offsets. Before a geometry batch it records the first intersecting item and that item's offset from the viewport. Stable measurements in one `ResizeObserver` delivery are accepted together, the prefix geometry is rebuilt once, and the anchor resolves to one corrected scroll position. `ReviewDiffPanel` requests Lit's render and applies that correction afterward. Each mounted wrapper uses the coordinator's absolute top inside a fixed-total-height relative container; a worker completion therefore cannot push visible siblings while reconciliation is pending. Wrappers are keyed by stable review item ID so overlapping windows retain their mounted Pierre renderer rather than recycling every positional node and restarting worker work as the range moves. Newly mounted wrappers reserve their estimated block height until Pierre completes, keeping the sticky file surface present while highlighting starts.

Measurement stability is explicit. Expanded items are measured only after Pierre's post-render has no placeholder and the expansion has settled. Collapsed items are measured only after transient spring content is unmounted. Unlike the previous forward-only/measurement-exception approach, valid measurements above the viewport are retained and corrected semantically, and equal overscan before and after supports reverse scrolling. File-tree navigation records its target, re-resolves that target when geometry changes during native smooth scrolling, and clears/stops the programmatic scroll on wheel, touch, pointer, or scrolling-key input. Native CSS anchoring remains disabled so there is only one owner of correction.

The resulting seams are: parsing/reconciliation owns records, the coordinator owns persistent virtual geometry and anchoring, the panel owns collapse/navigation/events and DOM scroll synchronization, Lit owns keyed mounting, and `ReviewDiffItem` owns a Pierre `FileDiff` only for its mounted lifetime. This remains deliberately top-level: pooling, rich previews, context expansion, and patch streaming are deferred.

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

| Area | `codeview` prototype | Future review direction |
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
- pure virtual geometry selects a bounded viewport/overscan window and finds active/target offsets
- many-file panel contract proves offscreen file wrappers are not mounted
- file-tree navigation works without target or preceding item DOM mounted
- measured and collapse-driven height updates preserve the scroll anchor
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

## Completed virtualization slice

- [x] The Reins-owned list avoids mounting every file container, with a many-file DOM contract.
- [x] Mounted records render Pierre-backed diffs from raw patch metadata and use the shared worker pool.
- [x] File-tree navigation and active-item tracking work from geometry without all item DOM mounted.
- [x] Collapse and measured-height changes preserve the viewport anchor.
- [x] The item model remains open to mixed Reins review content without deprecated Pierre APIs.
- [x] Classic remains stable and default.

Fluid inline context expansion retains the endpoint/item-state/anchoring direction documented above, but its content retrieval and interaction remain deferred.
