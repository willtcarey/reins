# Frontend Architecture

The frontend is a Lit + Tailwind CSS v4 SPA bundled with `bun build`. It communicates with the backend via REST (fetches) and a WebSocket (real-time events and commands).

## Build flags

Frontend dev-only code uses the compile-time `REINS_DEV` Bun define so production builds can exclude dev-only branches. The dev supervisor and frontend `dev` script pass `--define REINS_DEV=true`; the production build script passes `--define REINS_DEV=false`.

## Source Organization

```
src/
├── models/          Pure logic — no LitElement, no html``
├── ui/              Domain-agnostic Lit presentation primitives
├── components/      Feature and domain Lit components
├── controllers/     Lit reactive controllers (glue between models + components)
├── directives/      Reusable element-local Lit behavior
├── routing/         Browser route registration and navigation
├── __tests__/       Tests mirroring app structure
└── index.ts         Entry point
```

**Dependency rules:** `models/` never imports Lit layers. `ui/` contains domain-agnostic presentation primitives and does not import from `models/`, `components/`, or `controllers/`. Feature components and controllers may import from `models/` and `ui/`.

```
  components/  ──→  models/  ←──  controllers/
       │              ↑                │
       ├────────→ controllers/         │
       └────────→ ui/ ←────────────────┘
```

### models/

Pure TypeScript with no Lit dependency. Contains business/domain logic, state management, data extraction, and server communication. Components keep view-local state; anything that decides what data means, when to fetch, how to persist, or how cross-component state changes belongs here. Everything here is directly testable with bun:test — no DOM, no browser.

**Organize model files around domain concepts, not individual derived values or operations.** Keep a concept's types, transformations, and behavior together. Extract a separate module only when that behavior forms a substantial, cohesive abstraction of its own.

```
models/
├── stores/              Shared state management (pubsub)
│   ├── app-store.ts
│   ├── workspace-store.ts
│   ├── active-session-store.ts
│   ├── diff-store.ts
│   ├── conversations-store.ts
│   ├── project-store.ts
│   ├── project-history-store.ts
│   ├── projects-store.ts
│   ├── file-browser-store.ts
│   ├── quick-open-store.ts
│   └── settings-store.ts
├── changes/             Diff/highlighting pure logic
│   ├── diff-sort.ts, diff-utils.ts, file-tree-state.ts
│   ├── highlighter.ts, highlight-worker.ts
│   └── types.ts
├── tools/               Tool data extraction helpers
│   ├── read.ts, edit.ts, write.ts, bash.ts
│   ├── create-task.ts, delegate.ts, generic.ts
│   └── bash-command-parser.ts
├── reins-client.ts      Resource-oriented internal REST client
├── code-review.ts       Pure review anchor/placement functions
├── agent-message.ts     Raw runtime/transport message protocol types
├── message.ts           Displayable message domain model
├── chat-state.ts        Chat event reducer
├── format.ts            Display formatting helpers
└── ws-client.ts         WebSocket client
```

### routing/

Browser-facing route registration, hash resolution, URL construction, navigation, page rendering, and last-route persistence. Routing is application infrastructure rather than domain logic, so it must not live under `models/`. `router.ts` is the generic matcher/renderer registry; `app-router.ts` composes application routes and their page renderers and exposes the application navigation helpers.

### ui/

Domain-agnostic Lit presentation primitives shared across features. UI primitives own reusable visual and interaction contracts without importing feature stores or domain models. Current primitives include `icons.ts` for shared icon templates, `info-card.ts` for linked/actionable information rows, `action-menu-presenter.ts` for context-menu and anchored touch-menu presentation, and `popover-menu.ts` with `position.ts` for viewport-aware anchored popovers.

`action-menu-presenter` opens a touch menu from a long press's anchor (the pressed item's rect and the touch point). `touchMenuPlacement` puts the menu below a short item (up to 120px, such as a row), or above when there is no room. Taller items, and items that leave no room either way, get the menu just above the touch point. It aligns the menu to the item edge nearer the viewport side and sets the transform origin where the menu meets the item. The presenter positions the panel after the popover is shown and measured, then springs its scale, opacity, and backdrop in. `close()` resolves the dismissal and dispatches `action-menu-dismiss` at once, so callers and the pressed item respond immediately, while the menu springs back out without intercepting pointer input before it is removed. Reduced motion skips both springs.

Delegate popovers render `session-list-item` rows inside another session row. Their activation handler must retain its own element binding and stop the nested `info-card-activate` event before it reaches the containing row; the resulting `select-session` event still bubbles for navigation. Native popovers display in the top layer but remain DOM descendants, so card hover styling is scoped to the direct primary control rather than the entire card subtree.

### components/

Feature and domain Lit custom elements that own rendering and user interaction. Import from `models/` for data, from `controllers/` for lifecycle-managed behavior, and from `ui/` for shared presentation primitives.

```
components/
├── changes/             Review surface components
│   ├── review-diff-panel.ts, review-file-diff.ts
│   ├── diff-file-tree.ts, diff-file-action-buttons.ts
├── tools/               Tool-specific chat renderers
│   ├── read.ts, edit.ts, write.ts, bash.ts
│   ├── create-task.ts, delegate.ts, generic.ts
│   ├── index.ts (registry), types.ts
├── app.ts               Root shell: lifecycle, route outlet, and global overlays
├── app-workspace.ts     Routed workspace: panes, responsive layout, and workspace-local state
├── project-history.ts   Routed full-screen project History page
├── chat-panel.ts        Message display + composer orchestration
├── message-action-menu.ts Touch/context-menu presentation
├── chat-composer.ts     Prompt input, autosize, skill suggestions, image attachments
├── session-sidebar.ts   Sidebar layout
├── session-list.ts, project-sidebar.ts, project-form.ts
├── task-list.ts, task-detail.ts, task-form.ts
├── branch-indicator.ts, quick-open.ts, search-palette.ts
├── file-browser.ts, file-search.ts, file-viewer.ts
├── toast.ts
└── app.css
```

When splitting or moving components, prefer the new canonical path immediately. Do **not** leave thin compatibility wrapper modules that only re-export from the new location. Update imports at call sites instead — wrapper files add indirection and make the component layout harder to navigate.

### controllers/

Lit reactive controllers — lifecycle-managed glue reused across components. See [reactive-controllers.md](reactive-controllers.md).

```
controllers/
├── app-route-controller.ts           Route-agnostic browser/Lit hash lifecycle adapter
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

All built-in REST calls go through the resource-oriented `models/reins-client.ts` interface (for example, `api.sessions.get(...)`, `api.projects.create(...)`, and `api.diff.patch(...)`). The client privately owns paths and query construction, request serialization, response decoding, typed HTTP errors, browser-resource URL construction, upload transport, and `AbortSignal` forwarding. Callers do not construct endpoint descriptors or URLs.

Shared request/response DTOs remain backend-owned and frontend imports from `@backend/*` must use `import type`; oxlint enforces this with no runtime-import exception. Stores remain responsible for caching, retries, loading/error presentation, request generations, and reactive state. The client is an internal module for the built-in frontend, not a plugin interface.

## Error handling

Follow the repo-wide [error handling guide](error-handling.md). For frontend code, unexpected render/runtime failures should bubble to browser/global error handling. Use local error UI only for expected, recoverable outcomes that are part of a feature contract, such as validation failures, failed REST mutations, or WS command errors.

## Store layer

All server communication — typed REST client calls, WebSocket event handling, polling, and invalidation — lives in the store/model layer. Views read state and render; they never fetch data or decide when to refetch.

Store/component boundary:

- **Stores own business logic** — domain mutations, persistence, server synchronization, derived selectors, validation that affects saved state, async flags/errors, and cross-component state.
- **Components own view state** — open/closed toggles, active tabs, drafts, hover/focus, scroll/measurement, and other transient state that only affects presentation.
- **Promote deliberately** — if state must survive remounts, be shared across routes/components, or drive server work, move it into a store; otherwise keep it local or extract it to a reactive controller.

```
                    ┌──────────────────────────────────────────────┐
                    │              components/app.ts                │
                    │  - creates AppStore + AppClient               │
                    │  - activates and renders registered routes    │
                    │  - owns global overlays and document state    │
                    └──────────────────┬───────────────────────────┘
                                       │ shared application context
                           ┌───────────▼───────────┐
                           │       AppStore         │
                           │  WS/client + long-lived│
                           │  caches/shared stores  │
                           └───────────┬────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │ components/app-workspace            │
                    │ owns one route-scoped WorkspaceStore│
                    └──────────────────┬──────────────────┘
                                       │ subscribe()
                    ┌──────────┬───────┴───────┬──────────┐
                    ▼          ▼               ▼          ▼
             session-sidebar  chat-panel   diff-panel  project-sidebar
                              (components/)
```

### Store map

Keep store descriptions at the ownership-boundary level. Avoid listing every endpoint, event, or feature a store currently supports; those details belong in code, tests, or feature-specific docs when they affect behavior.

- **AppStore** (`models/stores/app-store.ts`) — Application-lifetime composition and lifecycle context. It owns WebSocket connection state, `SessionCache`, `ConversationsStore`, `ProjectsStore`, `SettingsStore`, and reconnect/resume reconciliation orchestration. It does not expose domain mutation facades, interpret inbound message kinds or routes, or own the active workspace. Scoped stores register reconciliation work with it so browser resume and reconnect use one coordinator without introducing an event-forwarding bus.
- **WorkspaceStore** (`models/stores/workspace-store.ts`) — Route-scoped active-session and workspace coordinator owned by `app-workspace`. It owns `ActiveSessionStore`, `DiffStore`, and `CodeReviewStore`, derives `projectDir` from the current project and application metadata, subscribes directly to workspace-owned inbound message kinds, and filters session-scoped messages to its current session. WebSocket file-open paths are normalized here before a UI intent is dispatched. Every session change synchronously clears diff/review scope, resolves canonical session metadata and the task branch, then commits both scopes only if its transition is still current. A superseded transition may populate long-lived caches but cannot update workspace selection, diff, or review state.
- **DiffStore** (`models/stores/diff-store.ts`) — Git diff domain state, lightweight changed-file polling, raw patch loading, diff-mode selection, and branch synchronization. File-list, patch, and spread requests are generation-guarded so responses or errors from superseded project/branch scopes cannot restore stale data or diagnostics. Context expansion state belongs to the review model rather than the store; rendering concerns such as syntax highlighting stay in controllers/components.
- **CodeReviewStore** (`models/stores/code-review-store.ts`) — Synchronizes raw `CodeReviewState` for the viewed session's exact project/task scope and owns loads, optimistic annotation writes, submission, revision-aware invalidation reloads, and notifications. Pure functions in `models/code-review.ts` project saved annotations and build anchor evidence without wrapping transport state in another object. The panel's `InlineReviewController` owns one selection and composer across virtual remounts and exposes one per-file interface to the diff UI. Submission receives the selected session identity at action time; runtime activity remains owned by `SessionCache`.
- **SessionCache** (`models/stores/session-cache.ts`) — Canonical client cache for server-provided session metadata and the sole frontend owner of runtime activity. Stores and components derive running/activity views from it rather than duplicating activity in conversation or component state.
- **ActiveSessionStore** (`models/stores/active-session-store.ts`) — Route-scoped facade for the selected session. In addition to conversation actions and observation policy, it owns the selected session's normalized context snapshot. REST is the sole context source on route load, reconnect, and model change; existing canonical-entry and compaction-completion events coalesce refreshes, while a 10-second poll runs only when the running conversation is meaningfully observed. The last known snapshot remains visible while compaction is in progress, and request generations reject stale responses.
- **ConversationsStore** (`models/stores/conversations-store.ts`) — Keyed per-session conversation presentation state that survives route changes and missed streaming events. Durable AgentHarness `entry_added` events and REST pages use the same canonical `ConversationEntry` envelope: harness `id`, harness `parentId`, harness `seq`, optional Reins `clientId`, and a content-only `AgentMessage`. Both sources enter one idempotent ID-keyed upsert path. Optimistic inputs live in a separate insertion-ordered map keyed by `clientId`; a canonical envelope removes only its exact pending input. Submission-derived render keys remain stable through optimistic, durable-event, and page transitions, preserving send animation DOM identity. Streaming assistants are separate overlays keyed by the required runtime `streamId`; `message_end` can attach the durable entry ID so canonical insertion removes exactly that overlay. The pure reducer (`models/chat-state.ts`) replaces an overlay with any event that carries a full message (`message_start`, `message_end`, a keyframe `message_update`) and otherwise applies the update's step to `content[contentIndex]` with Pi's semantics (text and thinking deltas append, tool-call deltas append the raw argument JSON to `partialJson` while parsed `arguments` wait for `toolcall_end`, `*_end` is authoritative; see node-runtime.md *Streaming message updates*). A delta for an unknown stream changes nothing, and a step that does not fit the overlay's content marks it `stale`. Each `event` frame carries the session's `seq`; any jump (missed events, including across a WebSocket reconnect, or a restarted node counting from 1) marks the session's overlays stale. A stale overlay keeps its content and ignores deltas until the next keyframe (within about a second) or `message_end`. No-op events preserve state identity. Events apply to state immediately, but streaming partials (`message_update`, `tool_execution_update`) notify a session's listeners at most once per animation frame (with a 1s timeout fallback, since hidden tabs run no frames); every other change, including `message_start`, `message_end`, `entry_added`, `agent_end`, and seq-gap staleness, notifies synchronously and absorbs any pending frame. `flushNotifications()` delivers pending frames synchronously for tests. Partials for sessions with no listeners update state without scheduling anything. `get()` returns a view memoized per state object, and rebuilds `messages` only when `entries` or `pendingSubmissions` change and `streamingMessages` only when overlays change, so a streaming update leaves transcript `Message` objects identical and keyed `repeat` skips those rows. While a message streams, `<markdown-content>` renders settled block segments (split at blank lines outside fences, `$$` math, lists, and indented blocks; `models/streaming-markdown.ts`) that are parsed once, plus a re-parsed live tail; the unsplit render after streaming ends is authoritative, and code highlighting and mermaid wait until then. `agent_end` clears overlays and reports errors but never promotes another transcript. Compaction summaries appear only as canonical entries. There is no peer-message, FIFO, timestamp, or transcript fallback path. Stale/overlapping pages, reconnects, race ordering, and earlier-history loads therefore cannot consume unrelated state. Tool execution overlays remain keyed by tool-call ID, while persisted tool results are associated with their matching calls. Runtime activity remains solely owned by `SessionCache`.
- **ProjectsStore / ProjectStore** (`models/stores/projects-store.ts`, `models/stores/project-store.ts`) — Long-lived project/sidebar task and session list ownership plus project, task, and session-creation mutations. `ProjectsStore` is the aggregate interface: it hides child-store lookup policy, owns cross-project mutations and task/session creation, consumes task/session update subscriptions, and updates `SessionCache` as needed. `ProjectStore` retains one project's list state and detailed mutation implementation, including optimistic rename and explicit pin/archive updates with rollback. Route-scoped `WorkspaceStore` methods may add active-project context or route cleanup, but delegate domain work directly to `ProjectsStore`. Activity and session metadata are derived from `SessionCache` instead of stored redundantly. Normal lists exclude archived sessions and completed tasks.
- **ProjectHistoryStore** (`models/stores/project-history-store.ts`) — Page-owned state for one project's full-screen History page. It composes independently paginated and searched session/task resource requests, loads completed-task conversations on demand, and owns optimistic unarchive/rollback. `project-history` creates, loads, subscribes to, and disposes this store from its `projectId`; neither `AppStore` nor the sidebar's `ProjectStore` knows about History data.
- **QuickOpenStore** (`models/stores/quick-open-store.ts`) — Shared quick-open data, filtering, recency state, and session activity lookup through the application `SessionCache`. It subscribes to activity changes so an open palette rerenders indicators without a shell callback. Overlay open/closed state remains component-local.
- **FileBrowserStore** (`models/stores/file-browser-store.ts`) — Shared file browser data and file-content loading. File browser and search open operations explicitly provide a project ID; the store atomically sets that scope before fetching or selecting files. File locations are `{ projectId, path }`, and open-file intents never infer project scope from ambient workspace state. Viewer overlay state remains component-local.
- **ModelRegistryStore** (`models/stores/model-registry-store.ts`) — Provider/model registry data and derived selectors. Settings UI uses the instance owned by `SettingsStore`; other features may own their own registry instance when their data lifecycle is independent.
- **SettingsStore** (`models/stores/settings-store.ts`) — Persisted settings, auth/OAuth mutations, settings-panel model registry loading, and successful settings-change callbacks. `AppStore` owns the shared instance so app-wide preferences and the settings panel stay in sync. Settings saves run in the background; avoid adding `saving*` props or disabling setting controls for routine persistence. Settings components keep only form/view-local state such as drafts and overlay visibility; `components/settings/panel.ts` subscribes to store change callbacks and owns success toast copy. Setting declarations in the panel define each setting's persisted keys, visibility, and render function; the panel filters visible declarations and passes their keys to `SettingsStore.loadSettings(...)`.

### Subscription model

AppStore, WorkspaceStore, and DiffStore use a `Set<listener>` + `notify()` pattern. Components subscribe and trigger Lit re-renders on each notification. Fine-grained per-field subscriptions aren't needed — Lit's dirty checking keeps renders efficient.

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

Thin WebSocket wrapper for receiving server messages and sending session-scoped commands. Its inbound API publishes the original typed discriminated message envelope and accepts a typed handler map keyed by message kind. It filters delivery but does not decide how messages affect UI state. Prompt and steer commands remain buffered by client request ID until that request is explicitly accepted or rejected, so reconnect replay cannot drop or clear a neighboring submission; admission responses remain internal transport concerns.

Aggregate and scoped stores subscribe directly only to the message kinds they own: `ConversationsStore` owns conversation traffic and scoped errors, `ProjectsStore` owns task/session list invalidation, and `WorkspaceStore` owns review, file-open, and file-change reactions for its mounted scope. `AppStore` consumes connection state and coordinates reconnect/resume reconciliation, but is not an inbound message router. Components never subscribe to the WebSocket source.

### Activity indicator semantics

Session activity is server-authoritative and enters the frontend through `SessionCache`. Project/session views derive activity indicators from cached session metadata rather than raw runtime events or duplicated component state.

Running indicators remain visible while the agent loop is active. Finished indicators represent unread completed work and are cleared automatically only when the selected session's conversation is meaningfully visible: the document is foregrounded and the Chat surface is on screen (on mobile, Chat must be the active workspace page). Changes and other mobile pages do not count as viewing the conversation. Successfully reported child sessions are the lifecycle-owned exception: they clear directly after their result is admitted to the parent, while failed parent delivery leaves them finished/unread. `ChatPanel` reports whether its foreground conversation is meaningfully observed directly to its route-scoped `ActiveSessionStore`. The store owns the resulting policy: entering observation clears pending finished activity, completions are auto-read only while observed, and explicit unread intent is preserved until observation restarts or new work begins. It knows only the observation fact—not which app pane produced it—and serializes active-session read/unread requests. `ActiveSessionStore` owns the active session's read and unread operations, while idle sessions can also be marked unread through their project lists. Explicitly marking the open session unread is preserved until the conversation is viewed again or new work completes visibly. Reconnect/resume flows reconcile from the server snapshot instead of trusting missed client events.

## Routing (`routing/router.ts`, `routing/app-router.ts`)

`FrontendRouter` is a small registered hash router and page registry. Core routes are registered by `createAppRouter()`:

- `#/session/:sessionId` — view a specific session
- `#/projects/:projectId/history` — view a project's full-screen History page
- empty or unknown hash — render the workspace with no selected session

Route definitions declare a stable name and path pattern with named parameters, optional parameter validation, and a `renderPage` callback. Empty/root and session routes render the main workspace; History renders its full-screen page. Register future page routes with `router.register(...)` rather than adding parser or route-outlet conditionals; plugin-owned routes use the same registry with a namespaced route name, so matching, canonical hash construction, and page rendering remain one extensible seam.

`AppRouteController` is a route-agnostic browser/Lit lifecycle adapter. It listens for `hashchange`, restores and persists the last hash, resolves through the registered app router, reports every resolved `Route` through `onRouteChange`, and requests a host update. It does not interpret route names, invoke semantic route operations, or know about sessions. `app-shell` owns the active page route; its route-change handler assigns the resolved route and records quick-open recency for session routes. AppStore is intentionally absent from route interpretation and workspace selection.

The shell passes the long-lived application context plus the routed session ID to `app-workspace`. `app-workspace` creates and disposes its `WorkspaceStore`; `WorkspaceStore.setSession()` applies that page-scoped route input to session metadata, project context, task branch, diff scope, and review scope without becoming a routing API. Project pages own their page-specific stores. The chat panel is rendered with `keyed(store.sessionId, ...)` so switching sessions remounts per-session ephemeral UI while long-lived conversations and caches survive workspace/History navigation.

### Last-viewed hash restore

The router module provides `getLastHash()` and `saveHash()` helpers backed by `localStorage` (`reins:last-hash` key). `AppRouteController` saves `location.hash` on every `hashchange` event, and restores any registered route on fresh page loads when no hash route is present. This is a pure routing concern. If a stored session route points to a deleted session, the normal fetch-404 handling shows the empty state.

## Component structure

`app-workspace` receives the application-lifetime AppStore context, owns one WorkspaceStore for its mounted route lifetime, and renders one canonical named pane set (`sessions`, `chat`, `changes`, `files`) into a single responsive workspace DOM. Keep that routed workspace—and especially `session-sidebar`—mounted across session route changes, including while selected-session project metadata is loading; only session/project-scoped pane content should change identity. The workspace grid is a four-page mobile swipe surface (`sessions → chat → changes → files`) and becomes a desktop CSS grid at the `md` breakpoint (`sessions | chat/changes | files`) via responsive classes. Chat and Changes each render their own main toolbar in their mobile page column so the toolbar travels with the pane during swipes; at the desktop breakpoint those toolbars collapse into the same center grid header and only the active main-pane toolbar is shown. Workspace navigation uses named `WorkspacePane` values rather than mobile page indexes; only `app-workspace` translates the mobile page order to workspace page numbers.

```
app-shell                    — root lifecycle, route outlet, and global overlays
├── app-workspace            — registered root/session page; owns responsive panes
│   ├── session-sidebar      — project-list orchestration and shared dialogs
│   │   ├── sidebar-project  — project section with assistant and active tasks
│   │   ├── project-sidebar  — project selector + CRUD
│   │   ├── task-form        — task creation
│   │   └── task-detail      — task edit/delete
│   ├── chat-panel           — conversation + composer orchestration
│   │   ├── chat-message
│   │   └── chat-composer
│   ├── review-diff-panel    — bounded Changes review surface
│   └── diff-file-tree       — workspace-owned changed-file pane/sidebar
├── project-history          — registered full-screen project History page
├── quick-open               — Cmd+K session search overlay
├── file-search              — Cmd+P file search overlay
├── file-browser             — file viewer overlay shell
│   └── file-viewer
└── settings-panel           — settings overlay
```

All components live under `components/`. Sub-directories (`changes/`, `tools/`) group related components.

### Desktop pane layout

`app-workspace` owns the stable `sessions` and `files` side-pane widths and sidebar collapse through `WorkspaceLayout` (`models/workspace-layout.ts`). The single workspace surface retains the same pane DOM while CSS custom properties size desktop columns; resizing never rekeys Chat or Changes. Desktop-only separators accept pointer drags, arrow-key steps, and Home/double-click resets. Layout is saved locally per browser device and invalid values fall back to defaults; narrow windows reserve center space. The mobile four-page grid and swipe order remain independent of saved desktop dimensions. This is a host-owned layout seam, not a plugin contract or docking system.

### Mobile workspace swipe

`components/app-workspace.ts` owns workspace rendering and delegates mobile swipe event wiring/state to `PageSwipeController` in `controllers/page-swipe-controller.ts`. The workspace uses a single inner `.workspace-surface` grid as the layout authority: mobile translates the four full-width page columns (`sessions → chat → changes → files`), while the `md` breakpoint changes that same grid to the desktop columns. The outer workspace shell only clips overflow and hosts pointer listeners; keep it `overflow-clip` so it never becomes a restorable scroll container that can desync the visible mobile page from `activePane`. Do not add a second desktop grid wrapper around the surface. The controller owns page-specific behavior — page clamping, edge resistance, release thresholds, translate targets, and page commits — and creates one short-lived `Swipe` instance from `models/swipe.ts` per pointer-driven swipe. The swipe instance lasts from accepted `pointerdown` through drag classification, release/cancel spring animation, click suppression, and completion; keep per-swipe mutable state there rather than adding reset-heavy gesture fields to the Lit component. The shared scalar spring animation lifecycle lives in the one-shot `Spring` class in `models/spring.ts`; its stiffness and damping can be tuned per instance while omitted values retain the shared defaults. Swipe-specific pointer classification and DOM opt-out predicates stay private to `models/swipe.ts`.

### Message actions

Each actionable `chat-message` declaratively renders its accessible attributes and context-menu/keyboard event bindings. It attaches the generic `${longPress(...)}` element directive with the message-content feedback target and the bound action's touch-menu callback. The directive owns only reusable DOM gesture behavior: primary-touch and pointer-identity filtering, movement/cancellation, the 500ms completion threshold, reduced-motion behavior, listener cleanup, and shared-spring animation. It does not transform the feedback target until the press completes, and it never prevents native pointer behavior, so horizontal code-block scrolling and conversation scrolling can claim a moving touch before any pressed styling is applied. On completion it measures the feedback target's rect, starts the pressed spring, and calls the callback with the rect and the touch point in the same task; the touch menu's entrance spring uses the same parameters and starts before the next frame, so the item springs in and the menu springs out as one motion. The feedback target remains pressed while the touch menu is open; until the completion settles, the directive ignores new touches on its element, because the message menu is rendered inside the pressed row and its touches bubble there.

`MessageActionsController` is the per-`chat-message` interface for feature behavior. The component binds a domain message with `actions.for(message)`, wires the returned handlers, and chooses whether to render the assistant-only direct-copy control. The controller owns Markdown conversion calls, clipboard work, errors, desktop feedback, menu routing, and cleanup. `message-action-menu` remains responsible for touch/context-menu presentation, positioning, focus, dismissal, and in-menu confirmation. `chat-panel` only dismisses open child actions on conversation scroll.

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
- **No WS event handling** — Views never listen to WebSocket messages. Aggregate and scoped stores subscribe to the typed event source for only the message kinds they own; `AppStore` coordinates connection lifetime and reconciliation rather than forwarding inbound events.

## Tool renderers (`components/tools/`)

Tool calls in the chat panel are rendered by tool-specific renderers rather than a generic JSON dump. Each tool (read, bash, edit, write, create_task, delegate) has a dedicated component in `components/tools/` that owns its full visual output. Pure data-extraction helpers live in `models/tools/`. A registry in `components/tools/index.ts` maps tool names to renderers, falling back to a generic renderer for unknown tools. Renderers receive `ToolBlockData` plus a narrow `ToolRenderContext`; the workspace threads only `projectId` and `projectDir` through the chat hierarchy so file tools normalize paths and emit explicitly project-scoped file locations without ambient workspace state.

`components/chat-panel.ts`'s `renderToolBlock()` is a thin 5-line dispatcher that looks up the renderer and calls `render()`.

See [tool-renderers.md](tool-renderers.md) for the full architecture, rendering tiers, and how to add new renderers.

## Changes subsystem

The diff/changes feature spans both `models/changes/` (pure logic) and `components/changes/` (Lit components):

**Pure logic (`models/changes/`):**
- `diff-sort.ts` — Sorting utilities for diff files
- `diff-utils.ts` — Shared file-type, line-wrapping, and HTML-escaping helpers
- `file-tree-state.ts` — UI-local state for tree expansion (not in store — ephemeral)
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
- `review-diff-panel.ts` — The Changes surface. It parses/reconciles raw patch records, maps review collapse and measurements into `VirtualListController`, renders the controller's bounded keyed window, and adapts active IDs and generic observations to review events and telemetry.
- `review-file-diff.ts` — One file diff's collapsible Reins-owned header, inline comments, context expansion, binary/large-file placeholders, and virtual-layout contract.
- `review-file-diff-renderer.ts` — Configures the shared `PierreRenderer` for `FileDiff`, including worker-render completion semantics and shared highlighting options.
- `diff-file-action-buttons.ts` — Shared Lit action buttons for opening, copying, and downloading changed files.
- `diff-file-tree.ts` — Collapsible changed-file tree with item-ID navigation and diff-mode selection.

`DiffStore` owns the diff lifecycle and exposes raw `/diff/patch` text (`patchData`) as a `Loadable<T>` value. `ReviewDiffPanel` parses it into renderer-owned records. Collapse markers are keyed by project, branch, item, and reviewed content. The retired parsed JSON diff payload is not loaded or exposed.

The Changes surface's geometry, mounting, navigation, anchoring, measurement, and cleanup contracts are defined in [review-virtualization.md](review-virtualization.md). Generic virtual behavior belongs to `VirtualListController` and `VirtualListCoordinator`; review policy remains in `ReviewDiffPanel`. Pierre-backed renderers share one `WorkerPoolManager` from `pierre-worker-pool.ts`, while the review `FileDiff` and standalone file source renderer also share `PierreRenderer` for ref mounting, input reconciliation, completion, and cleanup. Their theme variables live on `<diffs-container>` hosts in `app.css`; only selectors that target shadow-DOM internals remain renderer-local. Rich Markdown, HTML, image, PDF, and binary file-viewer renderers remain outside Pierre. Tool output and Markdown code blocks continue to use the shared Shiki highlighter independently of the Changes renderer.
