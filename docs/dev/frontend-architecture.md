# Frontend Architecture

The frontend is a Lit + Tailwind CSS v4 SPA bundled with `bun build`. It communicates with the backend via REST (fetches) and a WebSocket (real-time events and commands).

## Build flags

Frontend dev-only code uses the compile-time `REINS_DEV` Bun define so production builds can exclude dev-only branches. The dev supervisor and frontend `dev` script pass `--define REINS_DEV=true`; the production build script passes `--define REINS_DEV=false`.

## Source Organization

```
src/
├── models/          Pure logic — no LitElement, no html``
├── components/      Lit components — rendering + interaction
├── controllers/     Lit reactive controllers (glue between models + components)
├── directives/      Reusable element-local Lit behavior
├── __tests__/       Tests mirroring app structure
└── index.ts         Entry point
```

**Dependency rule:** `models/` never imports from `components/` or `controllers/`. Everything else can import from `models/`.

```
  components/  ──→  models/  ←──  controllers/
       │                               │
       └──────→  controllers/  ←───────┘
```

### models/

Pure TypeScript with no Lit dependency. Contains business/domain logic, state management, data extraction, and server communication. Components keep view-local state; anything that decides what data means, when to fetch, how to persist, or how cross-component state changes belongs here. Everything here is directly testable with bun:test — no DOM, no browser.

**Organize model files around domain concepts, not individual derived values or operations.** Keep a concept's types, transformations, and behavior together. Extract a separate module only when that behavior forms a substantial, cohesive abstraction of its own.

```
models/
├── stores/              Shared state management (pubsub)
│   ├── app-store.ts
│   ├── active-session-store.ts
│   ├── diff-store.ts
│   ├── conversations-store.ts
│   ├── project-store.ts
│   ├── projects-store.ts
│   ├── file-browser-store.ts
│   ├── quick-open-store.ts
│   └── settings-store.ts
├── changes/             Diff/highlighting pure logic
│   ├── diff-sort.ts, diff-utils.ts, file-tree-state.ts
│   ├── highlighter.ts, highlight-worker.ts, scroll-spy.ts
│   └── types.ts
├── tools/               Tool data extraction helpers
│   ├── read.ts, edit.ts, write.ts, bash.ts
│   ├── create-task.ts, delegate.ts, generic.ts
│   └── bash-command-parser.ts
├── code-review.ts       Review transport types and pure anchor/placement functions
├── tasks.ts             Task list types
├── agent-message.ts     Raw runtime/transport message protocol types
├── message.ts           Displayable message domain model
├── chat-state.ts        Chat event reducer
├── format.ts            Display formatting helpers
├── router.ts            Hash-based route parsing
└── ws-client.ts         WebSocket client
```

### components/

Lit custom elements that own rendering and user interaction. Import from `models/` for data, from `controllers/` for lifecycle-managed behavior.

```
components/
├── changes/             Diff viewer components
│   ├── diff-panel.ts, diff-file-card.ts, diff-file-tree.ts
│   ├── diff-hunk.ts, diff-markdown-preview.ts
├── tools/               Tool-specific chat renderers
│   ├── read.ts, edit.ts, write.ts, bash.ts
│   ├── create-task.ts, delegate.ts, generic.ts
│   ├── index.ts (registry), types.ts
├── app.ts               Root shell: store/routing/overlays + pane rendering/layout selection
├── chat-panel.ts        Message display + composer orchestration
├── message-action-menu.ts Action sheet/context-menu presentation
├── chat-composer.ts     Prompt input, autosize, skill suggestions, image attachments
├── session-sidebar.ts   Sidebar layout
├── session-list.ts, project-sidebar.ts, project-form.ts
├── task-list.ts, task-detail.ts, task-form.ts
├── branch-indicator.ts, quick-open.ts, search-palette.ts
├── file-browser.ts, file-search.ts, file-viewer.ts
├── popover-menu.ts, toast.ts
└── app.css
```

When splitting or moving components, prefer the new canonical path immediately. Do **not** leave thin compatibility wrapper modules that only re-export from the new location. Update imports at call sites instead — wrapper files add indirection and make the component layout harder to navigate.

### controllers/

Lit reactive controllers — lifecycle-managed glue reused across components. See [reactive-controllers.md](reactive-controllers.md).

```
controllers/
├── store-controller.ts               Generic store subscription
├── inline-review-controller.ts       Panel-lifetime selection/composer coordination
├── pierre-renderer.ts                Ref mounting, input identity, completion, and cleanup for Pierre renderers
├── highlight-controller.ts           Shiki web worker bridge
├── lazy-highlight-controller.ts      IntersectionObserver + highlighting
├── page-swipe-controller.ts          Mobile page swipe event/state wiring
├── virtual-list-controller.ts        Bounded list viewport, measurement, anchor, and navigation behavior
└── chat-history-controller.ts        Prepend loading + scroll-anchor restoration
```

### directives/

Lit directives own reusable behavior attached to rendered DOM when that behavior needs direct DOM access and should not force the host component to mirror its event or animation state. `long-press.ts` attaches behavior to an existing element. The structural `spring-collapse.ts` directive accepts a lazy body renderer and owns its wrapper, content measurement, temporary mount state, reduced-motion handling, and direct spring animation so collapsed content can be removed after settling. It observes the inner body's natural height and retargets expansion when asynchronous content arrives or changes size. Without `ResizeObserver`, it skips animation and applies the requested mounted state immediately.

## Data Flow

The overall data flow is one-directional:

```
  Server (REST + WS)
         │
         ▼
  models/stores/     ← owns all fetches, WS events, polling
         │
         │ subscribe()
         ▼
  controllers/       ← lifecycle glue (StoreController, HighlightController)
         │
         │ host.requestUpdate()
         ▼
  components/        ← render from store state, dispatch intents via events
         │
         │ custom events (new-session, delete-task, etc.)
         ▼
  models/stores/     ← handles intents, triggers fetches
```

Views never call `fetch()` directly or listen to WebSocket events. Stores own business/domain decisions, persisted or server-derived state, async state, and event→refetch logic. Components own presentation and ephemeral interaction state.

## Error handling

Follow the repo-wide [error handling guide](error-handling.md). For frontend code, unexpected render/runtime failures should bubble to browser/global error handling. Use local error UI only for expected, recoverable outcomes that are part of a feature contract, such as validation failures, failed REST mutations, or WS command errors.

## Store layer

All server communication — fetching, WebSocket event handling, polling, and invalidation — lives in a centralized store layer. Views read state and render; they never fetch data or decide when to refetch.

Store/component boundary:

- **Stores own business logic** — domain mutations, persistence, server synchronization, derived selectors, validation that affects saved state, async flags/errors, and cross-component state.
- **Components own view state** — open/closed toggles, active tabs, drafts, hover/focus, scroll/measurement, and other transient state that only affects presentation.
- **Promote deliberately** — if state must survive remounts, be shared across routes/components, or drive server work, move it into a store; otherwise keep it local or extract it to a reactive controller.

```
                    ┌──────────────────────────────────────────────┐
                    │              components/app.ts                │
                    │  - creates AppStore + AppClient               │
                    │  - wires route/viewport controllers           │
                    │  - passes store to views (read-only)          │
                    │  - owns UI-local state (active pane, title)   │
                    └──────────────────┬───────────────────────────┘
                                       │
                           ┌───────────▼───────────┐
                           │       AppStore         │
                           │   (models/stores/)     │
                           │                        │
                           │  Owns app/domain state │
                           │  and coordinates        │
                           │  sub-stores             │
                           └───────────┬────────────┘
                                       │ subscribe()
                    ┌──────────┬───────┴───────┬──────────┐
                    ▼          ▼               ▼          ▼
             session-sidebar  chat-panel   diff-panel  project-sidebar
                              (components/)
```

### Store map

Keep store descriptions at the ownership-boundary level. Avoid listing every endpoint, event, or feature a store currently supports; those details belong in code, tests, or feature-specific docs when they affect behavior.

- **AppStore** (`models/stores/app-store.ts`) — Top-level orchestration for route-derived app state, WebSocket/reconnect side effects, shared app-wide settings, and sub-store coordination. Components should prefer semantic AppStore/sub-store methods over reaching into lower-level internals.
- **DiffStore** (`models/stores/diff-store.ts`) — Git diff domain state and mutations, including polling and expansion. Rendering concerns such as syntax highlighting stay in controllers/components.
- **CodeReviewStore** (`models/stores/code-review-store.ts`) — Synchronizes raw `CodeReviewState` for the viewed session's exact project/task scope and owns loads, optimistic annotation writes, submission, revision-aware invalidation reloads, and notifications. Pure functions in `models/code-review.ts` project saved annotations and build anchor evidence without wrapping transport state in another object. The panel's `InlineReviewController` owns one selection and composer across virtual remounts and exposes one per-file interface to the diff UI. Submission receives the selected session identity at action time; runtime activity remains owned by `SessionCache`.
- **SessionCache** (`models/stores/session-cache.ts`) — Canonical client cache for server-provided session metadata and the sole frontend owner of runtime activity. Stores and components derive running/activity views from it rather than duplicating activity in conversation or component state.
- **ConversationsStore** (`models/stores/conversations-store.ts`) — Keyed per-session conversation presentation state that must survive route changes or missed streaming events. Internally it retains raw persistence/runtime records so reconciliation remains faithful to those protocols; its public `ConversationView` projects them into `Message` domain objects as the primary display interface. Each display message carries its persisted entry/parent IDs or store-local render identity, owns raw Markdown copy semantics, and assistants expose ordered blocks whose tool calls already reference their matching persisted `ToolResultMessage` or live `ToolExecution`. Standalone tool-result records are therefore not display messages. Successful prompt and steer actions add optimistic user entries immediately; peer `user_message` events add equivalent live entries. Components own only outgoing animation metadata and must not maintain parallel pending-message or persistence-reconciliation state. `ActiveSessionStore.prompt()` and `steer()` return the exact `LiveConversationEntry` inserted so local-only interactions can use its store-local render key. Runtime `agent_end` user messages are ignored because they may contain runtime-only skill expansion. During a run, assistant display comes from normalized message snapshots; `agent_start` and `agent_settled` are presentation no-ops, while `agent_end` promotes fresh final assistants and tool results before clearing streaming assistants without completing runtime activity. Genuinely new persisted forward user rows consume pending live users FIFO, independent of content, and replace them with canonical persisted entries. Stale/overlapping pages and earlier-history loads never consume pending users. Persisted IDs flow through render keys and history anchors; do not reconstruct persisted identity from message content, roles, or timestamps. `ConversationsStore` owns persisted-message queries and cursor traversal, merges API records by ID and parent links, and reconciles live/streaming state separately. Ordered streaming snapshots keep only matching tool-execution overlays, keyed by stable tool-call ID; complete snapshot updates can recover missed starts/deltas. Persisted assistant timestamps remove matching streaming snapshots while unmatched newer work remains. Persisted tool results replace live results by tool-call ID. Disconnect and route/metadata updates do not discard received snapshots. When authoritative metadata is non-running, `ActiveSessionStore` narrowly clears only stale compaction presentation and synchronizes canonical messages when needed. Runtime activity remains solely owned by `SessionCache`.
- **ProjectsStore / ProjectStore** (`models/stores/projects-store.ts`, `models/stores/project-store.ts`) — Project/task/session list ownership and project-scoped mutations. Activity and session metadata are derived from `SessionCache` instead of stored redundantly.
- **QuickOpenStore** (`models/stores/quick-open-store.ts`) — Shared quick-open data, filtering, and recency state. Overlay open/closed state remains component-local.
- **FileBrowserStore** (`models/stores/file-browser-store.ts`) — Shared file browser data and file-content loading. Viewer overlay state remains component-local.
- **ModelRegistryStore** (`models/stores/model-registry-store.ts`) — Provider/model registry data and derived selectors. Settings UI uses the instance owned by `SettingsStore`; other features may own their own registry instance when their data lifecycle is independent.
- **SettingsStore** (`models/stores/settings-store.ts`) — Persisted settings, auth/OAuth mutations, settings-panel model registry loading, and successful settings-change callbacks. `AppStore` owns the shared instance so app-wide preferences and the settings panel stay in sync. Settings saves run in the background; avoid adding `saving*` props or disabling setting controls for routine persistence. Settings components keep only form/view-local state such as drafts and overlay visibility; `components/settings/panel.ts` subscribes to store change callbacks and owns success toast copy. Setting declarations in the panel define each setting's persisted keys, visibility, and render function; the panel filters visible declarations and passes their keys to `SettingsStore.loadSettings(...)`.

### Subscription model

Both AppStore and DiffStore use a `Set<listener>` + `notify()` pattern. Components subscribe and trigger Lit re-renders on each notification. Fine-grained per-field subscriptions aren't needed — Lit's dirty checking keeps renders efficient.

The preferred pattern is `StoreController` (see [reactive-controllers.md](reactive-controllers.md)), which handles subscribe/unsubscribe lifecycle automatically:

```ts
// Preferred — reactive controller handles lifecycle
private _storeCtrl = new StoreController<DiffStore>(this);

@property({ attribute: false })
set store(s: DiffStore | null) { this._storeCtrl.store = s; }
get store(): DiffStore | null { return this._storeCtrl.store; }
```

For top-level components that manage the store subscription manually (e.g. `diff-panel` which also has custom `_onStoreUpdate` logic), the manual pattern is still fine:

```ts
// Manual — when you need custom logic on each notification
connectedCallback() {
  this._unsub = this.store.subscribe(() => {
    this._onStoreUpdate();
    this.requestUpdate();
  });
}
```

## WebSocket client (`models/ws-client.ts`)

Thin WebSocket wrapper for receiving server events and sending session-scoped commands. It exposes callbacks only; it does not decide how events affect UI state.

`AppStore` is the store-layer consumer of WebSocket connection/event hooks. It translates events into store mutations, refreshes, and conversation updates. Components never listen to WS events directly.

### Activity indicator semantics

Session activity is server-authoritative and enters the frontend through `SessionCache`. Project/session views derive activity indicators from cached session metadata rather than raw runtime events or duplicated component state.

Running indicators remain visible while the agent loop is active. Finished indicators represent unread completed work and are cleared when the session is viewed. Reconnect/resume flows reconcile from the server snapshot instead of trusting missed client events.

## Routing (`models/router.ts`)

Hash-based routing with a single pattern:

- `#/session/:sessionId` — View a specific session
- (empty hash) — No session selected, show empty state

`AppRouteController` listens for `hashchange`, parses the route, and calls `store.setRoute()`. The store fetches the session data (which includes `project_id`) and derives the active project from it. The chat panel is rendered with `keyed(store.sessionId, ...)` so switching sessions remounts the component and clears any per-session ephemeral UI state.

### Last-viewed hash restore

The router module provides `getLastHash()` and `saveHash()` helpers backed by `localStorage` (`reins:last-hash` key). `AppRouteController` saves `location.hash` on every `hashchange` event, and restores it on fresh page loads when no hash route is present. This is a pure routing concern — the store layer is not involved. If a stored hash points to a deleted session, the normal fetch-404 handling shows the empty state.

## Component structure

`app-shell` renders one canonical named pane set (`sessions`, `chat`, `changes`, `files`) into a single responsive workspace DOM. Keep that shell—and especially `session-sidebar`—mounted across route changes, including while the selected session's project metadata is loading; only session/project-scoped pane content should change identity. The workspace grid is a four-page mobile swipe surface (`sessions → chat → changes → files`) and becomes a desktop CSS grid at the `md` breakpoint (`sessions | chat/changes | files`) via responsive classes. Chat and Changes each render their own main toolbar in their mobile page column so the toolbar travels with the pane during swipes; at the desktop breakpoint those toolbars collapse into the same center grid header and only the active main-pane toolbar is shown. App-level navigation should use named `WorkspacePane` values rather than mobile page indexes; only `app-shell` translates the mobile page order to workspace page numbers.

```
app-shell                    — root shell, creates store, applies routes, renders workspace panes
├── session-sidebar          — project-list orchestration and shared dialogs
│   ├── sidebar-project      — keyed project section; survives body collapse and retains task disclosure state
│   │   ├── assistant-session — project assistant row and previous conversations
│   │   └── task-list        — tasks with spring-collapsed completed tasks and session sublists
│   ├── project-sidebar      — project selector + CRUD
│   ├── task-form            — task creation (generate from prompt)
│   └── task-detail          — task edit/delete
├── chat-panel               — conversation ordering/history/streaming aggregates + composer orchestration
│   ├── chat-message         — one domain message's text/images/tools/summary/actions and local feedback
│   │   ├── longPress directive — element-local touch gesture + press animation
│   │   └── message-action-menu — action sheet/context menu lifecycle, focus, positioning, and menu feedback
│   ├── ChatHistoryController — earlier-history triggering + viewport preservation
│   └── chat-composer        — prompt input, autosize, skill suggestions, image attachments
├── diff-panel               — full diff view with file cards
├── diff-file-tree           — app-owned changed-file pane/sidebar
├── quick-open               — Cmd+K fuzzy search across all sessions
├── file-search              — Cmd+P fuzzy file search (uses search-palette)
├── file-browser             — file viewer overlay shell
│   └── file-viewer          — rich previews plus Pierre File-rendered source content
└── branch-indicator         — current branch display
```

All components live under `components/`. Sub-directories (`changes/`, `tools/`) group related components.

### Mobile workspace swipe

`components/app.ts` owns workspace rendering and delegates mobile swipe event wiring/state to `PageSwipeController` in `controllers/page-swipe-controller.ts`. The workspace uses a single inner `.workspace-surface` grid as the layout authority: mobile translates the four full-width page columns (`sessions → chat → changes → files`), while the `md` breakpoint changes that same grid to the desktop columns. The outer workspace shell only clips overflow and hosts pointer listeners; keep it `overflow-clip` so it never becomes a restorable scroll container that can desync the visible mobile page from `activePane`. Do not add a second desktop grid wrapper around the surface. The controller owns page-specific behavior — page clamping, edge resistance, release thresholds, translate targets, and page commits — and creates one short-lived `Swipe` instance from `models/swipe.ts` per pointer-driven swipe. The swipe instance lasts from accepted `pointerdown` through drag classification, release/cancel spring animation, click suppression, and completion; keep per-swipe mutable state there rather than adding reset-heavy gesture fields to the Lit component. The shared scalar spring animation lifecycle lives in the one-shot `Spring` class in `models/spring.ts`; its stiffness and damping can be tuned per instance while omitted values retain the shared defaults. Swipe-specific pointer classification and DOM opt-out predicates stay private to `models/swipe.ts`.

### Message actions

Each actionable `chat-message` declaratively renders its accessible attributes and context-menu/keyboard event bindings. It attaches the generic `${longPress(...)}` element directive with the message-content feedback target and the bound action's sheet callback. The directive owns only reusable DOM gesture behavior: primary-touch and pointer-identity filtering, movement/cancellation, the 650ms press-feedback delay and 900ms completion threshold, reduced-motion behavior, listener cleanup, and shared-spring animation. It does not transform the feedback target until the touch has remained stationary for the feedback delay, and it never prevents native pointer behavior, so horizontal code-block scrolling and conversation scrolling can claim a moving touch before any pressed styling is applied. The feedback target remains pressed while the mobile sheet is open.

`MessageActionsController` is the per-`chat-message` interface for feature behavior. The component binds a domain message with `actions.for(message)`, wires the returned handlers, and chooses whether to render the assistant-only direct-copy control. The controller owns Markdown conversion calls, clipboard work, errors, desktop feedback, menu routing, and cleanup. `message-action-menu` remains responsible for sheet/context-menu presentation, positioning, focus, dismissal, and in-menu confirmation. `chat-panel` only dismisses open child actions on conversation scroll.

### Sidebar layout

The sidebar shows all projects simultaneously as collapsible sections. Each expanded project contains an assistant row and a tasks section. The visual hierarchy uses indentation and a left accent border to group project contents.

```
▶ 📁 Acme API
▶ 📁 Dashboard
▼ 📁 Mobile App               ⋮
┃  💬 Assistant                ⋮  ← popover: "New conversation" + previous sessions
┃  TASKS                       +  ← inline new-task button
┃  ▶ Refactor auth flow        ⋮
┃  ▶ COMPLETED TASKS (3)
▶ 📁 Shared Libs
▼ 📁 Web Frontend             ⋮
┃  💬 Assistant                ⋮
┃  TASKS                       +
┃  ▶ Add dark mode support
┃  ▶ Fix pagination bug
┃  ▶ COMPLETED TASKS (12)
▶ 📁 Workers
[+ Add Project]
```

Key design decisions:

- **Left accent border** (`border-l-2`) on expanded content groups children visually without adding vertical space.
- **Project headers are `text-sm font-medium`**, larger than child items (`text-xs`), creating natural hierarchy.
- **Assistant row** is a plain clickable row, not a button. Previous conversations are tucked into its ⋮ popover menu.
- **"+ New Task"** is an inline icon button on the TASKS header, not a standalone row.
- **Projects auto-expand** when they're the active project or have running sessions.

### Reactive Controllers

Per-component state and behavior (collapse toggles, markdown preview, clipboard confirmation, etc.) should be extracted into [Reactive Controllers](reactive-controllers.md) rather than accumulated as `@state()` properties and private methods on the component. This keeps components thin and makes the logic testable with bun:test using a fake host. See [reactive-controllers.md](reactive-controllers.md) for the full pattern, testing approach, and migration guide.

### View conventions

- **Business logic in stores, view state in components** — Stores decide what data means and how it changes; components keep transient UI state needed to render and interact.
- **Read from store, don't fetch** — Views receive the store (or store state) as Lit properties and render from it. No direct `fetch()` calls.
- **Pass callbacks for action-only dependencies** — If a child only needs to trigger an action and does not subscribe to or render from store state, pass a narrow callback like `onSave` / `updateSessionModel` instead of the whole store.
- **Dispatch intents via events** — Views emit custom events (`new-session`, `delete-task`, etc.) for actions. The parent component or store handles the intent.
- **No WS event handling** — Views never listen to WebSocket events. All event→refetch logic is internal to AppStore.

## Tool renderers (`components/tools/`)

Tool calls in the chat panel are rendered by tool-specific renderers rather than a generic JSON dump. Each tool (read, bash, edit, write, create_task, delegate) has a dedicated component in `components/tools/` that owns its full visual output. Pure data-extraction helpers live in `models/tools/`. A registry in `components/tools/index.ts` maps tool names to renderers, falling back to a generic renderer for unknown tools.

`components/chat-panel.ts`'s `renderToolBlock()` is a thin 5-line dispatcher that looks up the renderer and calls `render()`.

See [tool-renderers.md](tool-renderers.md) for the full architecture, rendering tiers, and how to add new renderers.

## Changes subsystem

The diff/changes feature spans both `models/changes/` (pure logic) and `components/changes/` (Lit components):

**Pure logic (`models/changes/`):**
- `diff-sort.ts` — Sorting utilities for diff files
- `diff-utils.ts` — Pure helpers (isMarkdown, fileCardId, escapeHtml, gutterWidth, getHunkEndLine, diffLineKey)
- `file-tree-state.ts` — UI-local state for tree expansion (not in store — ephemeral)
- `scroll-spy.ts` — Tracks which diff card is visible for tree highlighting
- `highlighter.ts` — Pure-function interface to the Shiki Web Worker: text lines in, HTML lines out via callback. Exports `IHighlighter` for test fakes.
- `highlight-worker.ts` — Web Worker for off-main-thread Shiki highlighting
- `pierre-diffs-worker.ts` / `pierre-worker-pool.ts` — Shared `@pierre/diffs` worker entry plus sizing/highlighter setup for Pierre-backed source and diff renderers.
- `file-changes.ts` — Parses raw patches into stable file-change identities, Pierre cache keys, and path-to-change navigation records.
- `review-virtual-layout.ts` — Review-specific initial and collapsed height estimation for Pierre-backed review records.
- `models/virtual-list-coordinator.ts` — Generic persistent virtual-list geometry: estimated/measured and optional fixed heights, balanced bounded overscan, semantic anchors, active-item lookup, and offsets for unmounted IDs. `VirtualListController` owns its lifecycle and DOM synchronization; follow [review-virtualization.md](review-virtualization.md).
- `review-collapse-state.ts` — Encapsulates reviewed-content persistence behind `ReviewCollapseState`; production uses local storage, while tests inject the narrow storage interface. It restores matching collapse state and invalidates changed content.
- `types.ts` — Shared types for diff data structures

**Directive (`directives/`):**
- `spring-collapse.ts` — Shared structural spring-collapse behavior. It lazily renders a supplied body, tracks asynchronous body resizing, retains it through collapse, honors reduced motion, supports in-flight reversal, and unmounts it after settling. The shared `Spring` integrator substeps slow frames so stronger height springs remain stable instead of flashing between clamped extremes.

**Components (`components/changes/`):**
- `diff-panel.ts` — Layout shell: branch header, scroll container, file tree sidebar. Owns state coordination and wires child events to the DiffStore.
- `diff-renderer-shell.ts` — Chooses the active Changes renderer from the `diff_renderer` setting while keeping classic as the default path.
- `diff-file-card.ts` — Per-file card: collapsible header with copy/download actions, delegates to `<diff-hunk>` and `<diff-markdown-preview>`.
- `diff-hunk.ts` — Single hunk: separator/expand-up button, hunk header, diff lines, trailer/expand-down button.
- `codeview-diff-panel.ts` — Prototype renderer that consumes `DiffStore`'s raw `/diff/patch` text, parses renderer-specific CodeView diff data with `@pierre/diffs`, converts it into `CodeView` items, adds Reins header actions/collapse toggles, and lets Pierre own diff row rendering/highlighting/virtualization.
- `review-diff-panel.ts` — Reins-owned review adapter. It parses/reconciles review records, maps review collapse and measurements into `VirtualListController`, renders the controller's bounded keyed window, and adapts active IDs and generic observations to review events and telemetry.
- `review-file-diff.ts` — One file diff's collapsible Reins-owned header, expansion integration, and virtual-layout contract.
- `review-file-diff-renderer.ts` — Configures the shared `PierreRenderer` for `FileDiff`, including worker-render completion semantics and shared highlighting options.
- `diff-file-action-buttons.ts` — Shared Lit action buttons for opening, copying, and downloading changed files across diff renderers.
- `diff-markdown-preview.ts` — Markdown Diff/Preview tab bar and rendered content area.
- `diff-file-tree.ts` — Collapsible file tree with scroll spy integration

`DiffStore` owns the diff lifecycle and exposes the classic JSON representation (`fullData`) and raw `/diff/patch` text (`patchData`) as `Loadable<T>` values. The CodeView prototype and Reins-owned `virtualized` renderer both consume `patchData`, but each owns its renderer-specific parsed records. Collapse markers are shared across patch-backed modes and keyed by project, branch, item, and reviewed content.

The Reins-owned renderer's geometry, mounting, navigation, anchoring, measurement, and cleanup contracts are defined in [review-virtualization.md](review-virtualization.md). Generic virtual behavior belongs to `VirtualListController` and `VirtualListCoordinator`; review policy remains in `ReviewDiffPanel`. Pierre-backed renderers share one `WorkerPoolManager` from `pierre-worker-pool.ts`, while the review `FileDiff` and standalone file source renderer also share `PierreRenderer` for ref mounting, input reconciliation, completion, and cleanup. Their theme variables live on `<diffs-container>` hosts in `app.css`; only selectors that target shadow-DOM internals remain renderer-local. Rich Markdown, HTML, image, PDF, and binary file-viewer renderers remain outside Pierre.

`diff-file-card` and `diff-hunk` use `StoreController<DiffStore>` to re-render on store notifications. Each `<diff-hunk>` owns a `HighlightController` that sends the hunk's text lines to the Shiki web worker for syntax highlighting. The controller stores the resulting HTML strings — the highlighter never mutates `DiffLine` objects. During render, `diff-hunk` reads `controller.getLineHtml(index)` and falls back to escaped plain text if highlighting hasn't completed yet (see [reactive-controllers.md](reactive-controllers.md)).
