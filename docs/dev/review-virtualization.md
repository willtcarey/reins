# Review Virtualization

This document defines the implementation invariants for the Reins-owned virtualized review surface. Read it before changing `review-diff-panel.ts`, `review-diff-item.ts`, `review-virtual-layout.ts`, `review-file-diff-renderer.ts`, or `pierre-renderer.ts`.

The goal is to keep long reviews usable by mounting only a bounded top-level window while preserving normal review navigation and scrolling behavior.

## Ownership boundaries

Each layer has one owner:

- Patch parsing and reconciliation own stable review records and IDs.
- `ReviewVirtualCoordinator` owns top-level estimated/measured geometry, virtual windows, semantic anchors, and offsets for unmounted items.
- `ReviewDiffPanel` owns the actual scroll container, navigation, collapse coordination, batched coordinator commits, and active-file events. It observes only viewport size, not item DOM.
- Lit owns keyed mounting and removal of review item elements.
- `ReviewDiffItem` owns stable height observation and the render-readiness contract for one mounted file. It emits a narrow item-ID-and-height event only after the measurement is stable.
- `PierreRenderer` owns one Pierre instance and container generation for the mounted lifetime.
- Pierre owns diff rows and worker-backed highlighting inside the current container.

Do not introduce another owner for top-level file positions or scroll correction. In particular, Reins must not advance coordinator viewport state ahead of the scroll container, and Pierre must not control the outer review scroll.

## Required invariants

### Bounded mounting

- Keep all review records in JavaScript, but mount only the viewport plus balanced bounded overscan.
- Do not render placeholder wrappers for every file.
- A single large file must not cause every other file to mount.

### Stable identity and reuse

- Key mounted wrappers by stable review item ID.
- Files that remain in overlapping windows retain their component and renderer.
- A file that leaves the window may be destroyed; returning later creates a new mount generation.
- Completion callbacks and item-owned resize observations from an old generation must not affect the current generation.

### Geometry

- Every record always has usable estimated geometry, including before its DOM exists.
- Collapsed geometry is deterministic: the inter-file gap plus the fixed header estimate. Collapsed items are never measured, and collapsed measurement events are never accepted or stored.
- An expanded measured height may replace an estimate only when it belongs to the current item, content, and mount generation.
- Expanded measurements require a connected current article, the current Pierre container, a rendered `<pre>`, no placeholder, and no active collapse transition.
- Provisional worker renders, empty Lit teardown shells, stale observer deliveries, and duplicate renderer DOM are never stable measurements.
- Expanded measurements are retained by project, branch, item, and content fingerprint across a collapse/expand cycle; collapsed geometry temporarily overrides them without replacing them.
- The panel enriches accepted item measurement events with the current measurement key and commits them to the coordinator in a microtask batch, not one scroll correction per observed element.

### Reserved geometry

- A newly mounted expanded item reserves its coordinator-provided height until its current rich render is structurally complete.
- Removing reserved geometry must not expose a header-only or inter-file-gap-only shell.
- Absolute item positions and the fixed-total-height container prevent asynchronous children from pushing siblings before reconciliation.

### Scroll anchoring

- Before a geometry batch, preserve the first intersecting semantic item and its viewport offset.
- Apply at most one resulting correction after Lit has rendered the new absolute positions.
- The DOM scroll container is the source of truth for actual in-flight position.
- Native CSS scroll anchoring remains disabled for this surface; Reins owns correction.
- User wheel, touch, pointer, or scrolling-key input cancels programmatic navigation before anchor correction can fight it.

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
- Do not infer settled geometry merely because Pierre emitted a generic post-render callback; verify the current structure.

## Deferred work

Do not expand the scope of top-level virtualization incidentally. These remain separate work unless explicitly requested:

- Rich Markdown, image, PDF, or binary previews
- Fluid context expansion and complete-file retrieval
- Renderer or DOM pooling
- Patch streaming
- A second per-file virtualizer

If one of these changes ownership of geometry or scrolling, revise this document before implementation.

## Tests

The primary contract coverage lives in:

- `packages/frontend/src/__tests__/models/changes/review-virtual-layout.test.ts`
- `packages/frontend/src/__tests__/components/changes/review-diff-panel.test.ts`
- `packages/frontend/src/__tests__/components/changes/review-diff-item.test.ts`
- `packages/frontend/src/__tests__/controllers/pierre-renderer.test.ts`

Regression tests should assert observable contracts such as bounded mounted records, stable navigation, preserved anchors, current render readiness, and cleanup across container generations. Avoid tests that only encode incidental private fields.

## Diagnostics

Development builds automatically capture bounded structured telemetry for this surface. See [client-telemetry.md](client-telemetry.md) for log location, retention, event format, and inspection commands.

When diagnosing a failure, correlate one navigation by `operationId` and compare:

- requested versus actual scroll position
- navigation and active indexes
- layout version and total height
- previous, reserved, measured, container, and `<pre>` heights
- renderer readiness, placeholder state, and shadow child count

Item-level readiness telemetry is recorded by `ReviewDiffItem`, which is the only layer allowed to inspect Pierre's child structure. Batch geometry, navigation, anchoring, and virtual-window telemetry remain panel-owned.

Telemetry is evidence, not an alternative contract. Fix the violated invariant rather than adding compensating scroll behavior around unstable geometry.
