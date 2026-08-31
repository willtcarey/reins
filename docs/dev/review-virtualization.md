# Review Virtualization

This document defines the implementation invariants for the Reins-owned virtualized review surface. Read it before changing `review-diff-panel.ts`, `review-file-diff.ts`, `virtual-list-controller.ts`, `virtual-list-coordinator.ts`, `review-virtual-layout.ts`, `review-file-diff-renderer.ts`, or `pierre-renderer.ts`.

The goal is to keep long reviews usable by mounting only a bounded top-level window while preserving normal review navigation and scrolling behavior.

## Ownership boundaries

Each layer has one owner:

- Patch parsing and reconciliation own stable review records, IDs, and compact content fingerprints. Virtual layout and collapse updates consume the retained fingerprint directly; they must never rescan serialized patch content during animation frames.
- The generic `VirtualListCoordinator` owns estimated/measured geometry, per-item leading gaps, bounded windows, semantic anchors, and offsets for unmounted IDs. Estimated, measured, and fixed heights describe content only; the coordinator adds `gapBefore` to produce each item's total slot height.
- The generic `VirtualListController` owns coordinator lifecycle, scroll-container and viewport synchronization, measurement microtask batching, post-render anchor correction, navigation and cancellation, render-frame scheduling, and scroll restoration. Its optional observation hook reports generic list behavior without importing review telemetry.
- `ReviewDiffPanel` is the review adapter. It owns patch reconciliation and height estimates, maps collapse to fixed geometry, resolves paths to item IDs, maps generic observations to review active-file events and telemetry, and coordinates store refreshes.
- Lit owns keyed mounting and removal of file-change elements.
- `ReviewFileDiff` measures its host only after the current Pierre render completes or an expansion spring settles. It uses `FileDiffContextState` directly for context acquisition and remount state. Height changes, context-expansion intent, and collapse intent cross the single panel boundary through direct callback properties; the panel decides how expansion affects virtual scroll. Reserve bubbling custom events for communication that intentionally crosses several component boundaries.
- `PierreRenderer` owns one Pierre instance and container generation for the mounted lifetime.
- Pierre owns diff rows, native context-expansion regions, and worker-backed highlighting inside the current container. `FileDiffContextState` coordinates lazy acquisition and retains Pierre's opaque region snapshot across virtual remounts. `loadFileContents` acquires the complete resulting file, while the patch module reconstructs the old file from the retained Git patch. New/deleted files derive both sides from their complete one-sided patches. Partial metadata must remain marked partial when passed to Pierre; for hunks whose patch metadata reports `collapsedBefore > 0`, its existing full-width separator-content row is exposed immediately with a Pierre-styled acquisition button because Pierre suppresses its native buttons for partial metadata. Merely mounting those controls does not acquire content. The user's first click, Enter, or Space activation starts acquisition, is retained while loading, and is replayed after the exact patch is hydrated with truthful complete metadata.

Do not introduce another owner for top-level item positions or scroll correction. In particular, the controller must not advance coordinator viewport state ahead of the scroll container, the review adapter must not duplicate generic scroll state, and Pierre must not control the outer review scroll.

## Required invariants

### Bounded mounting

- Keep all review records in JavaScript, but mount only the viewport plus balanced bounded overscan.
- Do not render placeholder wrappers for every file.
- A single large file must not cause every other file to mount.
- Files over the shared 10,000 changed-line limit retain bounded header/notice geometry and must not bind or schedule a Pierre renderer.

### Stable identity and reuse

- Key mounted wrappers by stable file-change ID.
- Files that remain in overlapping windows retain their component and renderer. Collapsing unmounts only the renderer; expansion rebuilds its target from the latest retained native context regions so the cached expanded height still matches the restored body.
- A file that leaves the window may be destroyed; returning later creates a new mount generation.
- `PierreRenderer` rejects completion callbacks from an old container generation.

### Geometry

- Every record always has usable estimated geometry, including before its DOM exists.
- Inter-file spacing belongs to the virtual list: item geometry reserves the leading gap and the mounted wrapper is positioned after it. `ReviewFileDiff` must not add its own outer padding or margin.
- Settled collapsed geometry is deterministic: the inter-file gap plus the fixed header estimate. During collapse and expansion springs, `ReviewFileDiff` reports the animated body height and the panel supplies it as temporary fixed geometry so following virtual items move with the spring instead of reserving either endpoint immediately. Collapsed items are never measured, and collapsed measurements are never accepted or stored.
- Render-blocked files start from bounded header/notice estimates and measure their Reins-owned surface after render so wrapped notices remain accurate at narrow viewports. They never wait for or inspect Pierre output.
- An expanded measured height may replace an estimate only when the file is connected, its current Pierre input has completed, and no collapse transition is active.
- The Pierre adapter does not report completion for placeholder renders. `ReviewFileDiff` measures only its own host and does not inspect Pierre-owned or spring-owned DOM.
- Opening a body taller than the review viewport springs only through one viewport of height before releasing to its full natural height. This keeps the visible reveal perceptible instead of traversing a multi-viewport target mostly below the fold; the final geometry release may move only siblings that are already offscreen. Closing continues to spring from the currently rendered height.
- Expanded measurements are retained by project, branch, item, and content fingerprint across a collapse/expand cycle; collapsed geometry temporarily overrides them without replacing them.
- The panel enriches accepted content measurements with the current measurement key; comment layout notifications advance that key synchronously before mounted file listeners can submit the corresponding DOM measurement. `ReviewFileDiff` deduplicates measurements against the same comment layout revision, so a new revision can re-submit an unchanged numeric height. The generic controller commits measurements to the coordinator in a microtask batch, and the coordinator adds the retained leading gap rather than requiring the panel to modify measurements.

### Reserved geometry

- A newly mounted expanded item reserves its coordinator-provided height until its current rich render is structurally complete.
- Removing reserved geometry must not expose a header-only or inter-file-gap-only shell.
- Absolute item positions and the fixed-total-height container prevent asynchronous children from pushing siblings before reconciliation.

### Scroll anchoring

- Before a geometry batch, preserve the first intersecting semantic item and its viewport offset.
- Collapsing the item that currently contains the viewport immediately aligns the viewport with that item's collapsed header instead of preserving an offset into its removed body.
- Every accepted geometry change requests a Lit repaint of absolute item positions, even when preserving the semantic anchor requires no scroll correction. Apply at most one resulting correction after that render.
- The DOM scroll container is the source of truth for actual in-flight position.
- Native CSS scroll anchoring remains disabled for this surface; Reins owns correction.
- User wheel, touch, pointer, or scrolling-key input cancels programmatic navigation before anchor correction can fight it.
- Inline context expansion uses the controller's generic `preserveScroll` transaction around Pierre's mutation. The transaction captures either the resizing item's end or an adapter-provided internal viewport point, waits for that item's next changed measurement, and commits geometry plus scroll correction together. Pierre's visually upward/from-end control reports direction `down`, so the adapter preserves the item end; the visually downward/from-start direction is `up` and needs no preservation because lines are inserted below reviewed code. Intervening user scroll intent cancels the transaction.
- Never expose Pierre controls by changing `FileDiffMetadata.isPartial` without reconstructing complete old/new line arrays. Reverse application must validate every patch context/addition line against the fetched resulting file; mismatches retain the partial diff and its failure behavior. Shiki highlighting treats non-partial hunk positions as indexes into complete contents.

### File navigation

- Navigation targets a stable item ID, not a mounted element.
- Navigation must work when the target and preceding files are unmounted.
- Starting navigation supersedes any queued correction from the previous viewport state.
- Geometry changes may re-resolve the target offset, but must not lose or silently replace the semantic target.
- Navigation completes only when the intended target reaches its valid resolved destination, including bottom-of-list clamping.
- Active-file reporting continues to derive from coordinator geometry.

### Renderer cleanup

- Releasing or reusing a managed Pierre container clears old Pierre-owned shadow children while preserving the Lit-owned host and adopted styles.
- Renderer completion is scoped to the current container generation.
- Repeated worker updates for one generation must not create duplicate `<pre>` or rendered row trees.
- A renderer adapter may signal completion only for the current container generation and after rejecting placeholder renders.

## Deferred work

Do not expand the scope of top-level virtualization incidentally. These remain separate work unless explicitly requested:

- Rich Markdown, image, PDF, or binary previews
- Renderer or DOM pooling
- Patch streaming
- A second per-file virtualizer

If one of these changes ownership of geometry or scrolling, revise this document before implementation.

## Tests

The primary contract coverage lives in:

- `packages/frontend/src/__tests__/models/virtual-list-coordinator.test.ts`
- `packages/frontend/src/__tests__/models/changes/review-virtual-layout.test.ts`
- `packages/frontend/src/__tests__/controllers/virtual-list-controller.test.ts`
- `packages/frontend/src/__tests__/components/changes/review-diff-panel.test.ts`
- `packages/frontend/src/__tests__/components/changes/review-file-diff.test.ts`
- `packages/frontend/src/__tests__/components/changes/review-file-diff-renderer.test.ts`
- `packages/frontend/src/__tests__/controllers/pierre-renderer.test.ts`

Regression tests should assert observable contracts such as bounded mounted records, stable navigation, preserved anchors, current render completion, and cleanup across container generations. Avoid tests that only encode incidental private fields.

## Diagnostics

Development builds automatically capture bounded structured telemetry for this surface. See [client-telemetry.md](client-telemetry.md) for log location, retention, event format, and inspection commands.

When diagnosing a failure, correlate one navigation by `operationId` and compare:

- requested versus actual scroll position
- navigation and active indexes
- layout version and total height
- previous, reserved, and measured heights
- current renderer input and completion state

`ReviewFileDiff` records accepted host measurements without inspecting Pierre's child structure. The generic controller emits an optional generic observation stream for batch geometry, navigation, anchoring, and window changes; `ReviewDiffPanel` alone adapts those observations to review/client telemetry.

Telemetry is evidence, not an alternative contract. Fix the violated invariant rather than adding compensating scroll behavior around unstable geometry.
