# Inline Review Comments on the Virtualized Diff

## Status and recommendation

**Investigation complete; in-memory MVP implemented; durable persistence not started.** This document is based on the exact installed `@pierre/diffs` **1.2.11** (`bun.lock` integrity `sha512-lSkl…`) and Reins' current `FileDiff` integration.

The implemented `virtualized` slice now uses an unmanaged nested `<diffs-container>`, public line annotations, controlled selection, and the public gutter callback. `InlineReviewComments` owns current-panel drafts, threads, grouping, normalization, and file-content reconciliation in memory. A Reins annotation element owns only rendering and commands. Whole-item resize observation feeds the top-level virtual list, comment layout revisions invalidate measurements, and the active composer item is pinned. A labeled file-header side/start/end form supplies the keyboard fallback. Comments survive collapse and virtual remount within the panel, but browser refresh and review-scope/content changes may discard them.

Use Pierre's public line-annotation and selection interfaces, but keep comment identity, persistence, interaction state, and top-level layout in Reins.

The recommended rendering path is:

1. Reins owns review threads and validates durable anchors against the current review snapshot.
2. A narrow Pierre adapter maps validated Reins placements to `DiffLineAnnotation<AnnotationMetadata>[]`.
3. Pierre inserts the variable-height inline row through `lineAnnotations` plus `renderAnnotation`.
4. Reins renders the composer/thread inside that row and measures the resulting **whole file item** for its top-level virtual list.
5. Pierre's selection and gutter callbacks are treated as pointer conveniences, not as the complete accessible interaction.

Do **not** put comments into `FileDiffMetadata`, add synthetic lines, fake `isPartial`, use functional hunk separators, mutate Pierre's rendered rows, or subclass the protected injected-row hooks.

One integration prerequisite mattered: Reins previously constructed `FileDiff` with its undocumented `isContainerManaged = true` constructor argument. In 1.2.11 that mode deliberately skips the vanilla `renderAnnotation` and `renderGutterUtility` mounting paths; React/CodeView supplies those slots externally. The MVP corrected this by letting an ordinary unmanaged `FileDiff` own a nested `<diffs-container>` under the Lit-owned mount. The Lit-owned node was not switched directly to unmanaged mode because `FileDiff.cleanUp()` removes an unmanaged file container.

The implementation is production-adjacent rather than a throwaway prototype. Focused adapter and presentation tests cover the supported interfaces; a real-browser interaction test remains useful evidence for annotation sizing, gutter behavior, and cleanup across supported browsers.

## Scope

This investigation answers whether the Reins-owned top-level virtual renderer can support:

- selecting an old/new line or same-side range;
- opening an inline composer;
- rendering persisted threads below an anchored line;
- retaining correct attachment across refreshes;
- surviving top-level virtual unmount/remount, collapse, and context expansion.

It does not design comment delivery to an agent, permissions, collaborative updates, or the final backend schema.

## Evidence and version caveat

Sources inspected on 2026-08-29:

- installed `@pierre/diffs@1.2.11` declarations and source-map implementation for `FileDiff`, `DiffHunksRenderer`, `InteractionManager`, `ResizeManager`, `VirtualizedFileDiff`, and `CodeView`;
- the package README and exports;
- current [diffs.com documentation](https://diffs.com/docs);
- current [DiffsHub](https://diffshub.com) behavior and assets;
- Reins' `ReviewDiffPanel`, `ReviewFileDiff`, `PierreReviewFileDiff`, item reconciliation, context expansion, and virtual-list controller.

The live docs are ahead of 1.2.11 in several places (for example `loadDiffFiles`, edit fields, annotation guards, and newer callback naming). This plan treats only interfaces present in the installed declarations as available. Live documentation is corroboration, not the version contract.

DiffsHub demonstrates CodeView's bounded rendering, collapse, context expansion, and responsive viewer. It is a read-only diff viewer and does not demonstrate a native comment product or a persistence model.

## Pierre capability matrix

| Capability | 1.2.11 support | Contract level | Consequence for Reins |
|---|---|---|---|
| Comment domain model, threads, drafts, persistence | No | — | Reins owns all comment behavior and data. |
| Inline annotations/widgets | Yes: `DiffLineAnnotation<T>`, `lineAnnotations`, `renderAnnotation`, `setLineAnnotations()` | Public | Recommended insertion mechanism. Annotation content is arbitrary `HTMLElement`; Pierre provides placement and row layout, not semantics. |
| File-level annotation | Yes: `lineNumber: 0` on a side | Public | Useful for detached/outdated summaries, not a substitute for a valid line anchor. |
| Side-specific line placement | Yes: `side: "deletions" | "additions"`, one-based `lineNumber` | Public | Adapter maps Reins `old/new` to Pierre `deletions/additions`. |
| Range annotation | No native range field | — | Store a range in Reins metadata and place its one widget on a chosen endpoint (normally visual end). |
| Multiple annotations on one line | Yes | Public, with implementation caveat | They share one generated slot/row. Reins should project one annotation per line placement and render all threads in it, avoiding ordering and duplicate-slot surprises. |
| Dynamic annotation height | Yes | Public | `ResizeManager` equalizes split-column annotation rows; ordinary DOM height changes flow into the file container. Reins must still observe and remeasure the whole top-level item. |
| Default gutter add button | Yes: `enableGutterUtility` + `onGutterUtilityClick(range)` | Public | Best pointer/touch trigger. The callback receives a single-line or dragged `SelectedLineRange`. |
| Custom gutter control | Yes: `renderGutterUtility(getHoveredLine)` | Public, advanced | Can supply Reins UI, but cannot be combined with `onGutterUtilityClick`; in managed mode Reins must own its slot. Prefer the default button until custom behavior is necessary. |
| Line and number events | Yes: click/enter/leave callbacks | Public | Exact 1.2.11 diff callback payload calls the side field `annotationSide`, despite newer docs showing `side`. Keep this mismatch inside the adapter. Events are pointer events. |
| Line/range selection | Yes: `enableLineSelection`, `SelectedLineRange`, start/change/end/committed callbacks, `setSelectedLines()` | Public | Suitable for pointer selection and controlled restoration. `start/end` preserve gesture direction and may have `side/endSide`. |
| Keyboard line selection | No | — | Pierre attaches pointer listeners and makes line numbers interactive visually, but does not provide a keyboard selection model. Reins needs an accessible fallback/interaction. |
| Selection across file items | `CodeView` only | Public | Not relevant to the Reins-owned list. Reins should permit one active selection/composer across the panel and clear the prior one itself. |
| Text selection lifecycle | `onPostRender` can attach native listeners | Public lifecycle | Not a code-review line anchor; do not derive durable comments from browser text selection. |
| Generic line widgets independent of annotations | No public `FileDiff` widget interface | — | Use annotations. |
| Protected injected rows | `DiffHunksRenderer.get*InjectedRowsForLine` exists | Exported types, protected/undocumented implementation hook | Reject. It requires subclassing renderer internals and recreating layout behavior. |
| Custom functional hunk separators | Present but deprecated | Deprecated | Reject. They represent collapsed regions, not lines, and are incompatible with the desired stable seam. |
| Post-render DOM mutation | Technically possible | Lifecycle is public; row structure is not | Restrict `onPostRender` to lifecycle, measurement, and documented event setup. Do not insert comment rows by querying `data-*` internals. |

### Annotation rendering details

For each annotated source line, Pierre emits an annotation row immediately after that rendered line. In unified mode old- and new-side annotations on the same visual row are combined into the unified annotation area. In split mode each side has a corresponding row and Pierre's `ResizeManager` keeps paired row heights equal. A file-level annotation renders before the first hunk/separator.

Annotations are coordinates on a **file side**, not hunk indexes or rendered row indexes. This is the right model for comments. An annotation appears only when its target line is part of the rendered metadata. A comment on lazily expanded unchanged context therefore requires the complete metadata and the relevant region to be expanded again before its widget is visible.

`setLineAnnotations()` only replaces the in-memory collection; `rerender()` applies it. The current generic `PierreRenderer` recreates an instance whenever its input changes, so the comment adapter should distinguish:

- file metadata changes, which may require a renderer replacement and expansion restoration; and
- annotation/selection changes, which should call public setters on the existing instance.

That distinction avoids restarting highlighting or losing expansion for every draft/thread update.

### Selection behavior in 1.2.11

- Pointer down starts selection only from the line-number column.
- Drag can extend through code or gutter rows; Shift-click extends an existing range.
- Clicking an already selected single line clears it on pointer up.
- `onLineSelectionStart`, `Change`, and `End` describe the gesture; `onLineSelected` is the committed result.
- Selection includes annotation rows in the visual highlight.
- A range can cross from one split side to the other. Reins should reject cross-side ranges for comment creation in the first slice because their meaning is unclear and no single Pierre annotation can represent them.
- `setSelectedLines(range, { notify: false })` can restore a controlled selection without emitting a second user action.

## Can Reins insert an inline thread without a fork?

**Yes.** The supported path is `DiffLineAnnotation` plus `renderAnnotation`; no fork and no false metadata are required.

The annotation metadata should be small and position-independent, for example:

```ts
interface PierreCommentPlacement {
  placementId: string;
}
```

Pierre receives one annotation per visible placement:

```ts
{
  side: anchor.side === "old" ? "deletions" : "additions",
  lineNumber: anchor.endLine,
  metadata: { placementId }
}
```

`renderAnnotation` resolves `placementId` back to Reins-owned state and returns a Reins custom element containing the composer and/or threads. Pierre should not receive comment bodies, persistence identifiers used as line identity, or fabricated file contents.

### Implemented adapter correction

The previous construction passed `true` as the third `FileDiff` constructor argument. That argument is not part of the documented usage. In managed mode, 1.2.11's `renderAnnotations()` clears its cache and returns, and `renderGutterUtility()` expects an externally supplied slot. This is why merely adding `renderAnnotation` to `REINS_DIFF_OPTIONS` would not work.

The MVP now uses:

```txt
Lit-owned mount node
  └─ Pierre-owned unmanaged <diffs-container>
       ├─ shadow diff rows and annotation <slot>s
       └─ light-DOM annotation/thread elements
```

The Reins adapter creates the ordinary `FileDiff`, calls `render({ containerWrapper })`, retains the resulting Pierre-owned node, and lets `cleanUp()` remove only that inner node. This uses default public ownership semantics and leaves the Lit node stable for `PierreRenderer` and the top-level virtual list.

An alternative external-slot adapter is possible because Pierre's React wrapper does it, but it couples Reins to generated slot names and managed-container implementation. Keep it as a fallback only if the nested public path proves incompatible in a browser.

## Durable anchor model

Line number and path alone are unsafe. File-level `contentKey` alone is too strict: a harmless edit elsewhere in the file would make every comment outdated. Use layered identity: durable review scope, a file-item hint, exact side/range evidence, and an explicit validation state.

### Sketch

```ts
type ReviewSide = "old" | "new";
type DiffMode = "branch" | "uncommitted";

interface ReviewScope {
  projectId: number;
  reviewSubjectId: string;       // task id, or scratch-session review id
  branch: string | null;
  diffMode: DiffMode;
  baseRef: string | null;
  baseRevision: string | null;   // exact comparison base when available
}

interface ReviewAnchor {
  path: string;                  // resulting/new path
  oldPath: string | null;        // previous path for rename lineage
  side: ReviewSide;
  startLine: number;             // one-based, inclusive
  endLine: number;               // one-based, inclusive; same side

  fileItemId: string;            // current Reins item identity, a lookup hint
  itemContentFingerprint: string;// exact reviewed per-file patch (`contentKey`)
  oldObjectId: string | null;    // full Git object id when authoritative
  newObjectId: string | null;

  rangeFingerprint: string;      // ordered exact selected-line hashes
  contextBeforeFingerprint: string | null;
  contextAfterFingerprint: string | null;
  anchorVersion: 1;
}

interface ReviewThread {
  id: string;
  scope: ReviewScope;
  anchor: ReviewAnchor;
  state: "active" | "outdated" | "resolved";
  comments: ReviewComment[];
}
```

### Identity rules

1. **Scope first.** A thread belongs to one project and review subject. Include branch and diff mode so branch and uncommitted reviews cannot silently share coordinates. A branch name is not sufficient because names can be reset/reused; the review subject and snapshot evidence prevent accidental reuse.
2. **Paths express lineage.** `path` is the new/resulting path; `oldPath` is retained for old-side and rename matching. Old-side content belongs to `oldPath ?? path`; new-side content belongs to `path`.
3. **Sides are Reins-owned.** Persist `old/new`, never Pierre's `deletions/additions` vocabulary.
4. **Lines are hints plus display coordinates.** They are never sufficient evidence after refresh.
5. **Exact unchanged item is the fast path.** If item identity and `itemContentFingerprint` match, attach at the stored coordinates after checking that the target line exists on the side.
6. **Changed item requires unambiguous local validation.** Search the same side/path lineage for the range fingerprint plus surrounding context. Reattach only on exactly one match; update current display coordinates while preserving the original anchor audit data.
7. **Changed selected text is outdated.** Do not attach by unchanged line number when the range fingerprint fails.
8. **Ambiguity is outdated, not guessed.** Repeated code with multiple context matches produces a file-level/outdated thread entry until a user reanchors it.
9. **Rename matching requires evidence.** Match path/old-path lineage plus side object/content fingerprints; never follow a same-named file by path alone after delete/recreate.
10. **Object IDs are evidence, not the whole interface.** Pierre exposes patch `prevObjectId/newObjectId`, but the current Git patch does not request `--full-index` and absent sides may be zero IDs. A persistence implementation should return authoritative full side/blob IDs or snapshot fingerprints from Reins' backend rather than treating abbreviated Pierre values as durable IDs.
11. **Expanded unchanged anchors validate lazily.** If the initial patch does not contain the selected range/context, retrieve the complete file through the existing bounded context path before creating or reattaching that anchor.

Do not overwrite an anchor's original evidence during automatic relocation. Store a separate current projection or relocation record so an incorrect future match can be audited and reversed.

## Recommended deep module and seam

The seam belongs between `ReviewFileDiff` and Pierre, not in `FileDiffMetadata`, `ReviewDiffPanel`, or each comment custom element.

### Reins-owned module

Call the module `InlineReviewComments` (name is provisional). Its small external interface should be expressed entirely in Reins types:

```ts
interface InlineReviewComments {
  project(context: ReviewFileContext): ReviewCommentProjection;
  dispatch(command: ReviewCommentCommand): Promise<void>;
  subscribe(listener: (fileItemId: string) => void): () => void;
}

interface ReviewCommentProjection {
  placements: readonly ReviewCommentPlacement[];
  selection: ReviewLineRange | null;
  openComposer: ReviewLineRange | null;
  hasDetachedThreads: boolean;
}
```

Behind this interface the module owns:

- anchor creation, normalization, validation, and relocation;
- one active panel selection/composer policy;
- drafts and thread state independent of DOM lifetime;
- persistence and optimistic/error state;
- grouping multiple threads into one line placement;
- old/new path and mode/branch scoping;
- detached/outdated projections;
- commands to create, cancel, save, resolve, and reanchor.

The deletion test justifies the module: removing it would spread anchor correctness, remount restoration, grouping, draft lifetime, and persistence coordination across the panel, renderer, and thread elements.

### Pierre adapter

A focused `PierreInlineReviewAdapter` inside `review-file-diff-renderer.ts` maps only:

- Reins placements → `DiffLineAnnotation<{ placementId: string }>`;
- Pierre `SelectedLineRange` → normalized same-side `ReviewLineRange`;
- gutter/selection callbacks → Reins commands;
- `renderAnnotation` → a Reins-owned annotation host element;
- controlled selection → `setSelectedLines`.

Pierre types stop at this seam. The domain module must not know hunk indexes, `DiffLineAnnotation`, `annotationSide`, shadow DOM selectors, or Pierre instance lifetime.

`ReviewDiffPanel` remains the owner of file ordering, top-level virtual geometry, collapse, navigation, and semantic scroll preservation. It supplies review scope and one `InlineReviewComments` instance to mounted file items. It does not manipulate individual threads.

## Interaction contract

### Pointer and touch

1. Clicking/tapping a line number selects that line.
2. Dragging the number gutter selects a same-side range; Shift-click extends on desktop.
3. The add-comment control follows the selected range's visual end. A single activation opens the composer below that endpoint.
4. A cross-side selection is visually allowed by Pierre but the add action explains that comments must select lines from one side.
5. On touch, the first line-number tap selects and reveals a large add action; a second activation opens it. The target must be at least 44×44 CSS px and must not depend on hover.
6. Only one new-comment composer is open per review panel in the first slice. Existing threads may remain expanded.
7. Opening a composer does not save a thread. Cancel clears an empty draft; navigating/unmounting retains non-empty draft state in the module.

### Keyboard and accessibility

Pierre 1.2.11 selection is pointer-only, and its built-in plus button has no accessible label in the generated markup. Therefore `enableLineSelection` alone is not an accessible comment interface.

Minimum accessible contract:

- A Reins-owned **Add inline comment** action is keyboard reachable from each file header. It opens a dialog/form with side, start line, and optional end line, initialized from the current selection when present. This is the no-private-DOM fallback for keyboard users.
- Pointer-created selection is announced in a polite live region (for example, “New lines 12 through 15 selected”).
- The gutter add action has `aria-label` containing side and range, a 44×44 touch target, and visible focus.
- Composer fields have explicit labels; Save/Cancel are buttons; `Escape` cancels with confirmation if the draft is non-empty.
- Opening moves focus to the composer. Saving/canceling restores focus to the invoking add action or, if it was virtualized away, to the file-header action.
- Threads use semantic author/time/body/action markup and do not put every code line in the tab order.
- Selected colors and focus indicators meet contrast requirements and do not rely only on red/green side color.
- Range order is normalized for speech (“old lines 20–24”) even though Pierre preserves drag direction internally.

A richer roving-tabstop keyboard gutter can be proposed upstream later. Do not implement it by assigning tabindex and key handlers to Pierre's private row markup in Reins.

### Mobile layout

- Inline content uses normal wrapping and cannot force the diff wider than the viewport.
- In split mode on narrow screens, prefer Reins' unified mode before introducing comments; a thread in one half of a narrow split view is not usable.
- Composer actions remain sticky within the annotation only if this does not conflict with the review header.
- Touch scrolling starting in the comment body must not become Pierre line selection; interactive annotation descendants should stop selection gestures only where needed.

## Virtualization, height, and lifecycle

### Height ownership

Pierre owns row and split-column annotation layout. Reins owns the file item's actual height and all downstream file positions.

The current `ReviewFileDiff._emitMeasurement()` runs after Lit updates and Pierre post-render completion. That is insufficient for comments because textarea auto-growth, async thread content, images, errors, and Pierre's annotation `ResizeObserver` may change height without a Lit update. Add a `ResizeObserver` on the mounted file article (or stable body wrapper) and submit debounced exact heights through the existing `onHeightChange` → `VirtualListController.measure` path.

Rules:

- Ignore zero and unchanged measurements.
- Keep the existing measurement key scoped by project/branch/item/content; add a comment-layout revision only to an **estimate/cache key**, not file identity.
- Do not add comment heights to `FileDiffMetadata` or hard-code them in `review-virtual-layout.ts`.
- Initial estimates may reserve a small known composer/thread minimum, but measured height is authoritative.
- Batch ResizeObserver entries to avoid resize/scroll feedback loops.

### Scroll anchoring

Use `VirtualListController.preserveScroll` for opening/closing a composer, expanding/collapsing a thread, and receiving content above the current viewport point.

- If the widget is below the semantic anchor, no scroll correction is needed.
- If it is above, preserve the selected line/widget viewport point through the next changed item measurement.
- Changes in an offscreen item above the viewport preserve the current visible item+offset, not a raw `scrollTop`.
- User wheel/touch/pointer/keyboard scroll intent cancels pending correction exactly as it does for context expansion.
- Native CSS scroll anchoring remains disabled; Reins has one anchoring owner.

A comment operation must not share or overwrite the pending context-expansion preservation transaction. The controller should serialize semantic height transactions or identify them by operation.

### Top-level virtual mount/unmount

All durable and interactive state lives outside annotation DOM:

- thread data and optimistic state;
- draft text and validation errors;
- open/closed state;
- active selection and composer anchor;
- desired focus restoration target.

On mount, the adapter projects annotations and restores selection without notification. On unmount, it removes listeners but does not discard module state. On remount, it recreates annotation hosts from placement IDs.

To avoid destroying focused editing UI during ordinary overscan movement, pin the one item with an open composer in the mounted set. Release the pin on save/cancel. If memory pressure or navigation requires unmount, retain the draft and move focus to a stable file-header/panel action before removal.

### Collapse

Collapsing removes Pierre and annotation DOM today. Preserve thread/draft state in `InlineReviewComments`, show a header badge for thread/draft counts, and restore widgets on expand. If focus is inside an open composer, collapse should first move focus to the header collapse control and announce that the draft remains available.

Collapsed fixed height remains header-only. Do not include hidden comment height in collapsed geometry. The expanded measured height cache may be reused only when both file content and comment-layout revision match; otherwise use an estimate until remeasured.

### Context expansion

Comments and expansion share line-side coordinates, so they compose without metadata changes.

- Existing comments on lines already in the partial patch render immediately.
- A new comment on an expanded unchanged line can be created only after complete content exists, allowing a proper fingerprint.
- On virtual remount, restore complete metadata, Pierre expansion regions, annotations, and selection in that order before final measurement.
- If a comment's line is valid but currently hidden in collapsed context, show it in an item/header count. Activating the thread should acquire complete content if needed, expand to the line through Pierre's public expansion method, then scroll to it. Do not place it on a nearby visible line.
- If validation fails after refresh, remove the line annotation and expose the thread as outdated/file-level review UI.

## Supported and rejected approaches

### Supported

- Public `DiffLineAnnotation` placement and arbitrary `HTMLElement` annotation content.
- Public line selection lifecycle and controlled `setSelectedLines`.
- Public default gutter utility for pointer/touch, with Reins-owned accessible fallback.
- Public `onLineClick`/`onLineNumberClick` where a single-line interaction is enough.
- Public `onPostRender` only for lifecycle-managed listeners/measurement, not row insertion.
- Reins-owned persistence and semantic scroll transactions.

### Rejected

- **Comments in `FileDiffMetadata`:** metadata describes source/diff truth; comments are application state.
- **Synthetic context or comment lines:** corrupts side indexes, highlighting, hunk expansion, and anchors.
- **`isPartial = false` on patch arrays:** already known to produce invalid expansion/highlight behavior.
- **Functional hunk separators:** deprecated and region-scoped, not line-scoped.
- **Protected injected-row hooks:** undocumented subclass seam with high upgrade and virtualization risk.
- **Mutation via `data-line`, `data-column-number`, or annotation slot-name selectors:** private rendered structure is not the application interface.
- **Overlay positioned from `getBoundingClientRect`:** does not participate in document height and fails wrap, resize, and remount.
- **Line number/path as persistence identity:** silently attaches to changed content.
- **Whole-file `contentKey` as the only anchor:** unnecessarily detaches valid comments when unrelated lines change.
- **Comment state inside returned annotation elements:** elements are recreated on rerender/unmount and cannot be the source of truth.
- **Adopting Pierre `CodeView` for comments:** it has annotation support, but would move mixed-content layout and item lifecycle back across the seam Reins deliberately owns.

## Risks and upstream gaps

1. **Managed-container mismatch.** Reins' current advanced constructor mode bypasses vanilla annotation mounting. Validate the nested unmanaged-container adapter in Chrome, Safari, and Firefox before building thread UI.
2. **No keyboard line selection.** The file-header line-range dialog is necessary for the first accessible slice; request a public keyboard/roving-gutter interface upstream.
3. **Gutter utility labeling.** The 1.2.11 default button has no generated accessible name. Reins may need custom content or an upstream fix.
4. **Safari custom-gutter behavior.** Current upstream docs warn of scroll jumping with custom gutter utility plus `line-info`. Prefer the default utility and verify Reins' supported Safari versions.
5. **Annotation lifecycle.** Annotation elements can be recreated. Draft/focus/state must remain Reins-owned.
6. **Measurement races.** Pierre's internal annotation sizing and Reins' outer sizing are asynchronous. A file-level ResizeObserver and one semantic scroll owner are mandatory.
7. **Stale anchor relocation.** Local fingerprint matching can be ambiguous; false detachment is safer than false attachment.
8. **Authoritative snapshot identity is missing.** The current patch response has a frontend cache version, branch, and base branch but no exact base/head snapshot manifest. Persistence work should add it.
9. **Hidden unchanged comments.** Reopening a comment outside patch context may require lazy complete-file acquisition and expansion.
10. **Partial metadata trailing region.** The existing Pierre limitation for unknown trailing content also limits direct navigation to a comment there until authoritative full contents are available.

## Incremental implementation slices

Each behavior slice starts with a failing contract test per `docs/dev/workflow.md`.

### 1. Public annotation adapter proof

- [x] Refactor `PierreReviewFileDiff` ownership so an unmanaged Pierre container is nested beneath the Lit mount without changing visible review behavior.
- [x] Add focused old/new annotation and selection adapter coverage.
- [ ] Add a real-browser interaction test proving inline placement, dynamic height, and inner-node-only cleanup across supported browsers. Focused adapter/component tests currently cover the contract without a browser system spec.
- [x] Preserve current context expansion behavior and tests.

### 2. Outer measurement contract

- [x] Observe mounted whole-file item height and feed annotation growth/shrink through the existing virtual measurement batch.
- [x] Preserve the Reins-owned annotation point where available and retain the generic virtual list's existing above-viewport correction and input cancellation.
- [ ] Add browser-level comment-height cases above, at, and below the selected line.
- [x] Invalidate expanded height measurements by comment-layout revision.

### 3. Reins anchor module, in memory

- [x] Introduce a small Reins projection/command module with no Pierre imports.
- [x] Implement same-side range normalization, endpoint grouping, drafts/threads, cross-side rejection, and current file-content-key invalidation.
- [ ] Add durable `ReviewScope`/`ReviewAnchor` evidence, outdated state, relocation, rename mapping, and ambiguous-context tests. The MVP deliberately clears changed-content state instead of relocating it.
- [ ] Add exact snapshot/base/head identity to the patch response before durable persistence.

### 4. Pointer/touch composer

- [x] Enable controlled Pierre selection and the public gutter add action.
- [x] Render one grouped Reins-owned annotation host per side/endpoint with an in-memory composer and deletable threads.
- [x] Preserve selection, draft, expansion, and thread projection across virtual unmount/remount and collapse.
- [x] Pin the open-composer item.
- [ ] Verify Pierre's default gutter touch behavior and scroll-vs-selection behavior in supported mobile browsers. Reins-owned fallback/composer actions use 44px touch targets.

### 5. Accessible keyboard path

- [x] Add the file-header **Add inline comment** action and labeled side/start/end dialog/form.
- [x] Add live selection announcements, explicit composer labels, focus movement/restoration, and Escape cancellation with non-empty-draft confirmation.
- [x] Cover keyboard-form creation without querying or modifying Pierre comment row internals.
- [ ] Complete browser accessibility verification for contrast, focus order, and assistive-technology announcements.

### 6. Persistence and refresh reconciliation

- Persist threads/comments separately from renderer records.
- Save original anchor evidence and current projection/relocation separately.
- Reconcile on patch refresh and surface outdated threads without line placement.
- Restore comments for exact snapshots; lazily hydrate expanded unchanged anchors.
- Only after this slice connect comments to agent/session feedback.

### 7. Navigation and polish

- Thread counts and draft indicator in file headers/tree.
- Navigate to visible, collapsed-context, collapsed-file, and outdated threads.
- Resolve/reopen/reanchor workflows.
- Performance fixtures with many files, many threads on one line, tall threads, and rapid live updates.

## Acceptance criteria for the first production milestone

- No deprecated/private Pierre extension point is used for comment placement.
- A comment can target one old/new line or a same-side range.
- A changed target never receives a comment solely because path and line number still match.
- Drafts and threads survive refresh, collapse, context remount, and top-level virtual remount.
- Opening/closing and async resizing do not visibly jump unrelated content.
- Pointer, touch, and keyboard-only users can create a comment.
- Large-diff safeguards remain in force; blocked files expose file-level review only.
- Classic and `codeview` remain unaffected while `virtualized` is developed.
