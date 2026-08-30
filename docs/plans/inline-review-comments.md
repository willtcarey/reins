# Inline Review Comments on the Virtualized Diff

## Status and recommendation

**Investigation complete; in-memory UI MVP plus a persisted code-review backend vertical slice implemented.** This document is based on the exact installed `@pierre/diffs` **1.2.11** (`bun.lock` integrity `sha512-lSkl…`) and Reins' current `FileDiff` integration.

The implemented `virtualized` slice now uses an unmanaged nested `<diffs-container>`, public line annotations, controlled selection, and the public gutter callback. `ReviewComments` owns current-panel drafts, threads, grouping, normalization, and file-content reconciliation in memory. A Reins annotation element owns only rendering and commands. Whole-item resize observation feeds the top-level virtual list, comment layout revisions invalidate measurements, and the active composer item is pinned. Comment creation stays attached to selecting code and using its gutter action; manual side/line-number entry was removed because it is not a credible review interaction. Comments survive collapse and virtual remount within the panel, but browser refresh and review-scope/content changes may discard them.

A small detached `CodeReview` entity represents the eventual server-synced ephemeral review. Its direct methods own annotation creation, review-wide source-key upsert, replies, and terminal lifecycle transitions. A SQLite store is only the persistence adapter: it creates, loads, lists, saves, and deletes entities while enforcing optimistic revision compare-and-swap. Unsaved composer text remains frontend-local draft state. Project/task-scoped REST routes now load the exact open review and atomically find-or-create, mutate through the domain model, and save one annotation with optimistic revision correctness. Successful commits emit only a scoped `code_review_updated` WebSocket invalidation; REST returns the authoritative aggregate. This slice still has no frontend synchronization initialization, Git/filesystem reconciliation, agent scripting, message compilation, or delivery.

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

It does not implement comment delivery to an agent, permissions, collaborative synchronization, or UI/backend integration. The standalone model and SQLite store define saved review state and optimistic persistence; the submission contract belongs to a future server mediator that can reconcile against current code.

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

Do not overwrite an anchor's original evidence during automatic relocation. Reconciliation is transient submission work: the server produces an exact, relocated, or unanchored resolution for the outgoing message without writing that projection back to the saved review.

## Ephemeral code-review domain and persistence contract

The detached entity lives at `packages/backend/src/models/code-review.ts`, without imports from Pierre, UI state, the database, Git, sessions, or message delivery. `CodeReview` owns operations and invariants concerning only its state: annotation creation, review-wide source-key upsert, replies, and transitions from `open` to `submitted` or `abandoned`. Annotation operations are rejected after either terminal transition. It has no command dispatch, composer state, persisted reconciliation projection, or handwritten JSON schema parser. “Draft” is reserved for unsaved composer text, which remains local frontend state.

- A code review belongs to one project and optionally one task. Its persistence status is only `open`, `submitted`, or `abandoned`; delivery attempts and retries are not domain state.
- Its annotations contain thread entries. Each entry has an identity, plain string `author`, body, creation time, and optional `sourceKey`/`sourceUrl`.
- A non-null `sourceKey` is unique across all entries in one review. Import upsert finds that key review-wide and updates the existing entry while preserving thread/entry identity, creation time, and original anchor evidence.
- Stored anchor evidence includes side/path lineage, range, excerpt/context, file and revision hints. Actual filesystem/Git matching remains future integration work and produces a transient exact, relocated, or unanchored submission resolution.
- No submission payload is modeled yet. That contract belongs at the future server submission seam, where annotations can be reconciled against current code.

Migration `022_create_code_reviews` and `code-review-store.ts` persist a structured envelope (`id`, project/task foreign keys, status, optimistic revision, and timestamps) plus one `annotations_json` column. The store is only a persistence adapter: create/get/list/save/delete, row mapping, and compare-and-swap. `saveCodeReview(review)` persists the detached entity's current state and returns a fresh entity with the incremented database revision; it never performs a lifecycle transition through store options. Migration `023_unique_open_code_review_scope` permits only one open review in each exact project/task scope, including one project-level review where `taskId` is null. Submitted and abandoned reviews remain as scope history. The synchronization interface should find or atomically create that open review on the first saved annotation, then use its returned identity and revision for later mutations.

`ProjectCodeReviews`, exposed through `ProjectModel.codeReviews()`, is the reusable project-scoped model for REST and future agent scripting adapters. It owns task-scope validation, atomic open-review find/create, optimistic concurrency, persistence, and post-commit invalidation. The detached `CodeReview` owns annotation range validity, open-state mutation rules, and identity uniqueness, exposing one broad typed `CodeReviewError` with an error kind for adapters. `code-review.ts` is the canonical source for code-review value types and their TypeBox schemas; domain types are derived from those schemas, and REST plus future scripting adapters reuse the same annotation input contract instead of redeclaring it. REST is a thin adapter over one route set: `GET /api/projects/:id/code-review?taskId=:taskId` and `POST /api/projects/:id/code-review/annotations?taskId=:taskId`; omitting `taskId` selects project scope. The POST accepts a client-generated annotation and entry identity plus an optional `expectedReview: { id, revision }` concurrency guard. Review identity is not required: without the guard the model finds or creates the one open exact-scope review. With the guard, missing, mismatched-scope, stale mutations, or terminal reviews conflict rather than switching scope/history. Reused annotation, entry, or source identities also conflict; after an uncertain network result, clients reload the authoritative review through REST rather than replaying identities. Each successful committed mutation broadcasts a scoped `code_review_updated` notification containing only project ID, nullable task ID, review ID, revision, and status. Frontend stores apply only newer revisions and reload the authoritative aggregate when the notification matches their active scope; initial load and WebSocket reconnect still use REST because broadcasts are not durable. A future cross-module submission workflow may coordinate Git reconciliation, sessions, messages, and broadcasts before marking and saving the review, but that orchestration must not move annotation or lifecycle rules out of the detached entity. No such submission payload is part of this slice.

The store relies on TypeScript/domain construction for the annotation shape; future shape changes should use ordinary database migrations rather than per-row schema versions or a handwritten parser for every JSON property. The database enforces foreign keys, lifecycle status, non-negative revision, valid JSON, and an indexed scope lookup. Annotation entries remain in one JSON aggregate because they share the review lifecycle.

This model/store slice remains separate from the current frontend-only `ReviewComments` projection module. Routes, client synchronization, persistence initialization, reconciliation, and UI integration should adapt it rather than expanding Pierre-facing state into the durable model.

## Recommended deep module and seam

The seam belongs between `ReviewFileDiff` and Pierre, not in `FileDiffMetadata`, `ReviewDiffPanel`, or each comment custom element.

### Reins-owned module

The `ReviewComments` module has a small external interface expressed entirely in Reins types:

```ts
interface ReviewComments {
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

`ReviewDiffPanel` remains the owner of file ordering, top-level virtual geometry, collapse, navigation, and semantic scroll preservation. It supplies review scope and one `ReviewComments` instance to mounted file items. It does not manipulate individual threads.

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

- Pointer-created selection is announced in a polite live region (for example, “New lines 12 through 15 selected”).
- The gutter add action has `aria-label` containing side and range, a 44×44 touch target, and visible focus.
- Composer fields have explicit labels; Save/Cancel are buttons; `Escape` cancels with confirmation if the draft is non-empty.
- Opening moves focus to the composer. Saving/canceling restores focus to a stable file-header control if the gutter action is no longer mounted.
- Threads use semantic author/time/body/action markup and do not put every code line in the tab order.
- Selected colors and focus indicators meet contrast requirements and do not rely only on red/green side color.
- Range order is normalized for speech (“old lines 20–24”) even though Pierre preserves drag direction internally.

Keyboard-only comment creation remains an explicit gap. Design a credible roving-tabstop or keyboard gutter interaction with Pierre/upstream rather than exposing manual side and line-number fields or assigning tabindex and key handlers to Pierre's private row markup in Reins.

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

Collapsing removes Pierre and annotation DOM today. Preserve thread/draft state in `ReviewComments`, show a header badge for thread/draft counts, and restore widgets on expand. If focus is inside an open composer, collapse should first move focus to the header collapse control and announce that the draft remains available.

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

1. **Managed-container mismatch.** Reins now uses the nested unmanaged-container adapter; validate it in Chrome, Safari, and Firefox before treating the comment UI as production-ready.
2. **No keyboard line selection.** Manual line-number entry was rejected as an implausible review interaction. Request or design a public keyboard/roving-gutter interface upstream.
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

### 3. Reins anchor and code-review modules

- [x] Introduce a small Reins projection/command module with no Pierre imports.
- [x] Implement same-side range normalization, endpoint grouping, drafts/threads, cross-side rejection, and current file-content-key invalidation.
- [x] Add a small `CodeReview` class with project/optional-task persistence scope, string-attributed thread entries, and review-wide source-key idempotency.
- [x] Preserve original anchor evidence without persisting transient reconciliation projections; defer the payload shape to the future submission mediator.
- [ ] Connect the frontend projection module to server-synced `CodeReview` instances; the current UI module still clears changed-content state and is not durable.
- [ ] Implement actual Git/filesystem reconciliation, rename mapping, and ambiguous-context matching as transient submission resolution.
- [ ] Add exact snapshot/base/head identity before persisted anchors are treated as refresh-durable.

### 4. Pointer/touch composer

- [x] Enable controlled Pierre selection and the public gutter add action.
- [x] Render one grouped Reins-owned annotation host per side/endpoint with an in-memory composer and deletable threads.
- [x] Preserve selection, draft, expansion, and thread projection across virtual unmount/remount and collapse.
- [x] Pin the open-composer item.
- [ ] Verify Pierre's default gutter touch behavior and scroll-vs-selection behavior in supported mobile browsers. Reins-owned fallback/composer actions use 44px touch targets.

### 5. Accessible keyboard path

- [x] Add live selection announcements, explicit composer labels, focus movement/restoration, and Escape cancellation with non-empty-draft confirmation.
- [x] Remove the file-header manual side/start/end form; users create comments from selected code, not entered coordinates.
- [ ] Design and implement a credible keyboard line-selection/gutter interaction through a public Pierre seam.
- [ ] Complete browser accessibility verification for contrast, focus order, and assistive-technology announcements.

### 6. Persistence and refresh reconciliation

- [x] Persist each code review as a project/task/status/revision envelope plus one annotations JSON aggregate.
- [x] Add exact-scope retrieval, optimistic compare-and-swap updates, and database-enforced uniqueness for the one open review in a scope.
- [x] Save original anchor evidence without persisting a current projection that would immediately become stale.
- [x] Add one optional-task-scoped REST route set over reusable `ProjectCodeReviews`, with optimistic conflicts and post-commit invalidation broadcasts.
- [ ] Initialize frontend synchronization in application state.
- [ ] Reconcile on patch refresh and surface outdated threads without line placement.
- [ ] Restore comments for exact snapshots; lazily hydrate expanded unchanged anchors.
- [ ] Only after these integrations connect comments to agent/session feedback.

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
- Pointer and touch users can create a comment; a credible keyboard-only line-selection interaction is required before production readiness.
- Large-diff safeguards remain in force; blocked files expose file-level review only.
- Classic and `codeview` remain unaffected while `virtualized` is developed.
