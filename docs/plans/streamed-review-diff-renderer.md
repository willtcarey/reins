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

2. [x] **Create renderer-specific file-change records.**
   - Parse the already-loaded raw patch into Reins-owned file changes.
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
   - File tree clicks resolve to file-change IDs.
   - Item-ID navigation works in the scaffold.
   - Active file state is reported through the abstraction instead of depending on all files being permanently mounted.

5. [ ] **Add Reins-owned behavior that `CodeView` cannot own cleanly.**
   - [x] Collapsed file state.
   - [x] Copy path / download / open in browser actions.
   - Markdown diff/preview tabs.
   - Image previews, PDF previews, and binary placeholders.
   - [x] Investigate inline comments and define the supported seam; see [Inline Review Comments on the Virtualized Diff](inline-review-comments.md).
   - [x] Correct the managed-container adapter and add an in-memory inline-comment MVP through Pierre's public annotations, selection, and gutter hooks. Reins owns drafts/threads, keyboard range entry, remount restoration, and outer measurement; durable anchors, backend persistence, and refresh reconciliation remain deferred. Do not put comments in diff metadata or use protected/deprecated row hooks.

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

8. [x] **Implement fluid inline context expansion through Pierre `FileDiff`.**
   - Treat each diff as a view into the complete file, with collapsed unchanged regions appearing naturally between hunks.
   - Use Pierre's `line-info` rows and `FileDiff.expandHunk`; Reins renders only the initial acquisition button that Pierre suppresses for partial metadata, while Pierre owns all complete-metadata expansion controls and region calculations.
   - Lazily retrieve the bounded complete resulting file on the first interaction with a Pierre line-info row, reverse-apply the retained Git patch to reconstruct the old file, and share the request for that reviewed item.
   - Keep the partial `FileDiff` mounted while acquisition is pending or fails. Remount once with complete metadata, replay the initiating call through `expandHunk`, and retain Pierre-reported regions only for unavoidable virtual remount restoration.
   - Reconcile rendered height through the existing virtual measurement path and compensate the interacted separator's viewport point.
   - Report retrieval, reconstruction, binary, and size failures beside the unchanged diff without replacing it.
   - Prefetching remains deliberately deferred.

9. [x] **Measure and compare.**
   - A local comparison of `classic`, `codeview`, and the Reins-owned virtual path confirmed that the virtualized renderer reaches representative many-file and large-file diffs faster while mounting a bounded file window.
   - The temporary benchmark harness, instrumentation, and generated results were removed after validating the direction; no renderer redesign or streaming work was justified from that measurement pass.

10. [ ] **Optionally add streaming/chunking later.**
    - If full-patch fetch/parse is a bottleneck, frame complete file patches from the raw stream and append item records in batches.
    - Treat streaming as an optimization, not the foundation of the renderer architecture.

The current CodeView renderer prototype proved an important point: **most of the immediate performance win comes from Pierre's `CodeView` top-level virtualization, not from streaming the raw patch.** That changes the next implementation direction.

## Current status and decision

The `diff_renderer` setting supports `codeview` for the direct Pierre `CodeView` proof point and `virtualized` for the Reins-owned review surface. Both fetch `/diff/patch` as full text. The Reins-owned path parses renderer-specific file changes, owns the file headers and item-ID navigation contract, and delegates text rows and worker-backed highlighting to Pierre `FileDiff`. Classic remains the default, so non-default renderer access is controlled by the stored preference rather than frontend dev-mode gating.

The `virtualized` renderer now keeps all file changes in JavaScript while the generic `VirtualListController` and `VirtualListCoordinator` expose only a balanced viewport/overscan window for keyed mounting. Its Reins-owned headers include accessible collapse controls plus the shared view, copy-path, and download actions. A collapsed item records the hash of that exact reviewed diff in local storage under its project, branch, and stable item ID; both diff modes share that reviewed state. Matching content remains collapsed across reconciliation, project switches, and reloads; changed content expands and invalidates the marker so a later revert also stays expanded. File-tree navigation resolves coordinator geometry and therefore works before the target wrapper exists. Active-file tracking uses that same geometry. Stable measurements are retained by item/content/render-state key and committed in batches against a semantic item plus viewport-offset anchor. Absolutely positioned wrappers in a fixed-total-height container prevent asynchronous sizing from moving siblings before the post-render scroll reconciliation. Balanced overscan supports reverse scrolling, while explicit input cancellation prevents smooth navigation and anchor correction from fighting touch, wheel, pointer, or keyboard scrolling. All renderer modes now retain the file surface but suppress diff-row rendering for a file above 10,000 additions plus removals; the Reins-owned list gives those notices bounded initial geometry, measures their wrapping surface, and never binds Pierre for them. Rich previews, pooling, patch streaming, and aggregate payload safeguards remain follow-up work.

In particular:

- Follow [Inline Review Comments on the Virtualized Diff](inline-review-comments.md) for comment anchors, interaction, accessibility, virtual measurement, and the Reins/Pierre seam. The installed Pierre 1.2.11 supports public line annotations and pointer selection, while Reins now owns the in-memory thread/draft MVP. Durable identity and persistence are still unimplemented.
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
  → store renderer-specific file changes outside DiffStore.fullData
  → render through a Reins-owned top-level virtual list
       ├─ code diff item: Pierre VirtualizedFileDiff/FileDiff pieces
       ├─ markdown preview item/panel: Reins renderer
       ├─ image/PDF/binary preview item/panel: Reins renderer
       ├─ file actions/header controls: Reins renderer
       └─ future annotations/comments/actions: Reins renderer
```

The key requirement for the eventual performance path is that the Reins-owned surface must be **CodeView-like**, not merely Pierre `Virtualizer` wrapped around thousands of mounted file containers. `CodeView` is fast because it keeps item records/heights for all files but only mounts DOM containers for the visible window plus overscan. The lower-level `Virtualizer` is more flexible but generally mounts every top-level file/diff container, which gives back a large part of the many-file performance win.

Because `classic` and `codeview` remain available fallbacks, the Reins-owned path was first built non-virtually to validate behavior. That scaffold has now been replaced: `ReviewDiffPanel` derives virtual geometry from stable renderer-owned file changes and mounts only a viewport/overscan slice. The panel retains navigation, active-item, and collapse coordination rather than introducing a second stateful virtualizer lifecycle. Performance evaluation can now use this bounded mounting path.

## Prototype findings to preserve

- `CodeView` validates that top-level item virtualization, DOM pooling, estimated heights, and worker-backed highlighting are the performance-critical pieces.
- `CodeView` worked because it did not render DOM placeholders/wrappers for every diff file. Rendering every top-level file container, even with virtualized bodies inside each file, loses the primary many-file win.
- Full-patch fetch is acceptable for now. Streaming likely helps time-to-first-file on huge diffs but is not required for the next architectural decision.
- Worker-backed syntax highlighting is required even in the non-virtual scaffold; main-thread highlighting can make the scaffold unusable before top-level virtualization is added.
- Raw patch parsing produces `FileDiffMetadata.isPartial === true`; complete old/new file contents are still required to reveal unchanged lines that are absent from the patch.
- Content retrieval is an internal detail, not a user-visible transition. The collapsed region should remain the stable interaction point while complete contents are acquired, then open inline without replacing the file surface.
- `FileDiff` does not expose an async pre-expansion hook, and intentionally suppresses expansion buttons when `FileDiffMetadata.isPartial` is true. Reins always passes that truthful partial metadata to Pierre: marking partial line arrays complete makes Pierre's highlighter expand absent context and can produce invalid Shiki decoration positions. For each leading or inter-hunk region whose following patch hunk reports `collapsedBefore > 0`, Reins makes Pierre's existing full-width `data-separator-content` row keyboard-accessible and inserts a matching visible acquisition button without changing Pierre's `data-expand-index` structure. Mounting those bounded controls does not acquire content; capture-phase click, Enter, or Space activation both starts acquisition and records the intended native expansion while loading. After acquisition Reins hydrates the retained per-file Git patch with complete old/new contents and replays that intent through public `FileDiff.expandHunk`. Reins does not prefetch mounted or offscreen items, add synthetic lines, fake metadata completeness, use deprecated custom separators, or implement expansion-region calculations.

## Detailed design notes

### Chosen virtual layout seam

`VirtualListCoordinator` now provides the persistent generic geometry model. Stable IDs remain the source of identity, while measurement keys invalidate stale fluid heights and optional fixed heights temporarily override them without discarding valid measurements. Inputs may declare `gapBefore`; estimated, measured, and fixed heights remain content-only while the coordinator adds that gap to total slot geometry. `review-virtual-layout.ts` retains only review-specific Pierre height estimation: Pierre's 20px row metric, each hunk's exact `unifiedLineCount`, line-info separator geometry, no-newline metadata rows, the Reins header, and the review-specific gap value.

`VirtualListController` owns coordinator lifecycle, actual scroll-container viewport synchronization, balanced pixel overscan, measurement microtask batching, semantic post-render anchor correction, active-item lookup, unmounted-ID navigation and retargeting/cancellation, render-frame scheduling, and scroll restoration. `ReviewDiffPanel` supplies file changes as generic virtual-list inputs, maps collapse to fixed height, renders the bounded window, and adapts generic observations to review events and telemetry. Each mounted wrapper uses coordinator geometry for its absolute top inside a fixed-total-height relative container; a worker completion therefore cannot push visible siblings while reconciliation is pending. Wrappers are keyed by stable file-change ID so overlapping windows retain their mounted Pierre renderer rather than recycling every positional node and restarting worker work as the range moves. Newly mounted wrappers reserve their estimated block height until Pierre completes, keeping the sticky file surface present while highlighting starts.

Measurement stability is explicit. Expanded items are measured only after Pierre's post-render has no placeholder and the expansion has settled. Collapsed geometry is deterministic—the inter-file gap plus fixed header estimate—so collapsed items are never measured; the previous expanded measurement remains cached and applies again after expansion. Unlike the previous forward-only/measurement-exception approach, valid measurements above the viewport are retained and corrected semantically, and equal overscan before and after supports reverse scrolling. File-tree navigation records its target, re-resolves that target when geometry changes during native smooth scrolling, and clears/stops the programmatic scroll on wheel, touch, pointer, or scrolling-key input. Native CSS anchoring remains disabled so there is only one owner of correction.

The resulting seams are: parsing/reconciliation owns review records; the generic coordinator owns persistent geometry; the generic controller owns virtual-list DOM behavior; the panel owns review collapse policy, path resolution, active-file events, stores, and telemetry adaptation; Lit owns keyed mounting; and `ReviewFileDiff` owns a Pierre `FileDiff` only for its mounted lifetime. This remains deliberately top-level: pooling, rich previews, context expansion, and patch streaming are deferred.

### Fluid inline context expansion

The interaction contract is that a diff behaves like a window into the complete file. Collapsed unchanged regions sit between visible hunks, and activating one reveals additional lines in that same position. Repeated activation can continue opening context until regions meet. Fetching complete file contents, rebuilding internal diff metadata, and updating virtual measurements must remain invisible implementation details; there is no separate “expanded mode” and no user-visible replacement of the file item.

The line or collapsed region the user acts on should remain visually anchored while its surrounding content opens. The renderer should update item height and compensate scroll position as needed rather than allowing content above the interaction point to push it away.

Acquisition reuses `GET /files/content` with the same semantics as file previews: an active or omitted branch reads the working tree, while a non-active selected branch reads that Git ref. Renames request the resulting path and retain the old path as reconstructed metadata. The frontend enforces a 1 MiB bound from `Content-Length` when available and while consuming the actual body, rejects binary MIME/placeholder/NUL/invalid-UTF-8 responses, and leaves the partial diff mounted on every failure. New and deleted files make no content request because Git includes their complete one-sided text in the patch.

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

### Completed context expansion seam

`GET /files/content` owns resulting-file acquisition and preserves file-preview ref behavior: active/omitted refs stream the working tree, and a non-active selected ref streams that branch's blob. Binary placeholder responses carry an explicit response header so expansion cannot mistake their human-readable message for source text. The frontend checks declared and consumed byte size, MIME, NUL bytes, and UTF-8 validity under the 1 MiB safeguard.

`FileDiffContextState` owns acquisition outcomes, per-file request sharing, and an opaque copy of expansion regions reported by Pierre for virtual remount restoration. It delegates content loading to `loadFileContents` and complete metadata construction to `buildFileDiff`; it does not apply directional increments or reproduce Pierre's joining/clamping rules. Each `FileChange` retains its exact per-file Git patch. The focused `patch` module reverse-applies that patch to complete resulting text, validates every context/addition line and hunk range, and supports multiple hunks, additions/deletions, zero-length ranges, and no-newline-at-EOF markers. New/deleted file sides are derived directly from their complete one-sided patches. The reconstructed sides then go through `processFile(filePatch, { oldFile, newFile })` exactly as before, without regrouping reviewed hunks. `ReviewFileDiff` leaves the truthful partial Pierre `FileDiff` mounted during loading and failures. `review-file-diff-renderer.ts` configures the supported `line-info` UI; before complete contents exist, it identifies leading/inter-hunk acquisition rows from `collapsedBefore`, exposes Pierre's existing full-width separator-content row, and inserts a Pierre-styled visible acquisition button without fetching merely because the bounded control is mounted. Capture-phase pointer/keyboard interception starts acquisition only on the first activation, guarantees `expandHunk` cannot see incomplete arrays, and retains that click, Enter, or Space intent while loading; after acquisition, the intent and every subsequent reveal delegate to public `FileDiff.expandHunk`, which produces Pierre's native full-width controls. Its small `PierreReviewFileDiff` subclass exposes the protected renderer's public expansion snapshot solely because Pierre's `FileDiff` has no public remount serialization interface. No mounted-control prefetch, synthetic line content, false `isPartial` value, custom hunk separator, trailing control, or parallel expansion model is used.

The generic virtual list remains the geometry owner. Context expansion runs through its generic `preserveScroll` transaction, which captures the selected semantic anchor, performs Pierre's mutation, waits for the resizing item's next changed measurement, and commits geometry plus scroll correction together. Pierre's visually upward/from-end control reports direction `down`, so the adapter preserves the item end and scrolls by measured growth; the visually downward/from-start control reports `up` and needs no transaction because context is inserted below reviewed code. Bidirectional expansion supplies a resolver for Pierre's internal separator point. This prevents bottom clamping against stale total height; intervening user scroll intent cancels the transaction.

Pierre limitation: partial metadata cannot describe trailing context unless an authoritative total line count is separately available, and Pierre does not emit native expansion buttons for any partial region. Reins can safely use an existing leading/inter-hunk line-info row whose following hunk has `collapsedBefore > 0`, but a partial patch with no such row (for example, a sole hunk at line 1 with only unknown trailing content) cannot trigger lazy acquisition. Fixing that completely requires an upstream Pierre async content hook or authoritative totals; Reins will not preload every file, fake metadata completeness, or reintroduce a parallel trailing control. Other limitations: context state is in-memory for the current panel scope rather than persisted across reloads; failed acquisition is terminal until the diff scope/item changes; and the 1 MiB resulting-file limit is fixed. Prefetching, rich previews, patch streaming, and renderer polish remain deferred.
