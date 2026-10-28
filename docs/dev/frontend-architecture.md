# Frontend Architecture

The frontend is a Lit + Tailwind CSS v4 SPA bundled with `bun build`. It communicates with the backend via REST (fetches) and a WebSocket (real-time events and commands).

## Build flags

Frontend dev-only code uses the compile-time `REINS_DEV` Bun define so production builds can exclude dev-only branches. The dev supervisor and frontend `dev` script pass `--define REINS_DEV=true`; the production build script passes `--define REINS_DEV=false`.

## Source Organization

```
src/
├── models/          Pure logic — no LitElement, no html``
├── ui/              Domain-agnostic Lit presentation primitives
├── helpers/         Small framework-free utilities (fuzzy-match, loadable, clipboard, chat-send-animation)
├── components/      Feature and domain Lit components
├── controllers/     Lit reactive controllers (glue between models + components)
├── directives/      Reusable element-local Lit behavior
├── routing/         Browser route registration and navigation
├── reins-sdk/       The Reins SDK, imported as `@reins/sdk` (index.ts) (reins-sdk.md)
├── sdk-host/        The app's side of the SDK: createReinsSdk, the view, decorator and command registries, SdkSessions
├── extensions/      Built-in extensions, one folder each, written against the SDK (reins-sdk.md)
├── __tests__/       Tests mirroring app structure
└── index.ts         Entry point
```

**Dependency rules:** `models/` never imports Lit layers. `ui/` contains domain-agnostic presentation primitives and does not import from `models/`, `components/`, or `controllers/`. `models/` and `ui/` can share a helper that imports nothing of the app (`helpers/fuzzy-match.ts`). Feature components and controllers may import from `models/` and `ui/`. `reins-sdk/` imports only its own modules; built-in features (*The Reins SDK*, below) import `@reins/sdk` rather than `sdk-host/` or the app's stores. `extensions/` holds the built-in features that are separate from the app's own code: each folder is one extension, which gets everything through the SDK (lint: `reins/features-through-sdk` covers `extensions/**`) and may import pure helpers from `models/` (`path-utils`).

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
│   ├── project-files.ts
│   ├── file-browser-store.ts
│   ├── quick-open-store.ts
│   ├── settings-store.ts
│   └── nodes-store.ts
├── changes/             Diff/highlighting pure logic
│   ├── diff-sort.ts, diff-utils.ts, file-tree-state.ts
│   ├── highlighter.ts, highlight-worker.ts
│   └── types.ts
├── tools/               Tool data extraction helpers
│   ├── read.ts, edit.ts, write.ts, bash.ts
│   ├── create-task.ts, delegate.ts, generic.ts
│   └── bash-command-parser.ts
├── api.ts               The app's `api` client (`@reins/client`) and its XHR upload transport
├── code-review.ts       Pure review anchor/placement functions
├── inspector.ts         The Inspector's tabs (`View` is in `@reins/sdk`)
├── file-loader.ts       One file's content for a viewer (`FileLoader`)
├── decorated-html.ts    Message text with decorators applied, as HTML with view mounts (Markdown and plain text)
├── slash-suggestions.ts What the composer suggests for a `/` token: commands at a message's start, then skills
├── workspace-pages.ts   Workspace panes and their mobile pages (`WorkspacePages`)
├── agent-message.ts     Raw runtime/transport message protocol types
├── message.ts           Displayable message domain model
├── chat-state.ts        Chat event reducer
├── format.ts            Display formatting helpers
├── session-operations.ts A session's operations over HTTP, in order, retried (`SessionOperations`)
└── ws-client.ts         WebSocket client (broadcasts in, heartbeat out)
```

### routing/

Browser-facing route registration, hash resolution, URL construction, navigation, page rendering, and last-route persistence. Routing is application infrastructure rather than domain logic, so it must not live under `models/`. `router.ts` is the generic matcher/renderer registry; `app-router.ts` composes application routes and their page renderers and exposes the application navigation helpers.

### ui/

Domain-agnostic Lit presentation primitives shared across features. UI primitives own reusable visual and interaction contracts without importing feature stores or domain models. Current primitives include `icons.ts` for shared icon templates, `info-card.ts` for linked/actionable information rows, `action-menu-presenter.ts` for context-menu and anchored touch-menu presentation, `popover-menu.ts` with `position.ts` for viewport-aware anchored popovers, `dialog.ts` for modal dialogs, `confirm-dialog.ts` for confirmations, `choice-selector.ts` for an inline choice that opens a `popover-menu` with the `.content` it is given, and `choice-menu.ts`, a searchable list for that content (the new session page's project and task; `components/model-picker.ts` gives its own panel, on that page and under a session's conversation).

**Dialogs (`ui/dialog.ts`).** `<app-dialog>` is the modal shell: a native `<dialog>` shown with `showModal()` (top layer, focus kept inside, the page behind inert) with the shared backdrop (`backdrop:bg-black/50 backdrop:backdrop-blur-sm`) and panel (`bg-zinc-800`, `border-zinc-600`, `width` `sm` 24rem or `md` 28rem, 1rem from a phone's edges), a `heading`, an optional `subtitle`, a template-valued `body` and an `actions` row (right-aligned). The owner controls it: it shows while `open` and renders nothing otherwise; Escape, a click on the backdrop or the browser closing it fire `dialog-cancel` instead of closing it, and the owner sets `open = false` (closing gives focus back to where it was). Once shown, it focuses the element marked `autofocus` (and with `selectOnOpen` selects its text, e.g. a name to rename). With `.onSubmit` it is a form dialog: body and actions are one `<form>`, so a `type: "submit"` button or Enter in a text field submits, and so does ⌘/Ctrl+Enter anywhere in it (for textareas); the form's own submission is prevented and `onSubmit` runs, which must ignore a submit while one is in flight (a disabled submit button does not stop ⌘/Ctrl+Enter). A busy state stays with the owner: it disables and relabels its own buttons (`dialogButton({disabled})`). `dialogButton({label, variant, onClick, type?, disabled?, autofocus?})` renders an action button: `cancel` (text), `primary` (blue) or `destructive` (red). The shell renders light DOM (Tailwind styles are global, so there are no slots): body and actions are properties, and because `<app-dialog>` renders them, their event handlers must be arrow functions (an unbound method gets the shell as `this`). Every modal dialog uses the shell: `session-move-dialog`, `delete-task-dialog`, `confirm-dialog`, and the form dialogs `session-rename-dialog`, `task-form`, `task-detail` and `project-form`. Each keeps its own `open()`/`close()` (or, for `delete-task-dialog`, its `task` property) and toggles the shell's `open`; none calls `showModal` or handles Escape or the backdrop itself. Dialog errors are inline (`project-form`, `session-move-dialog`) or toasts, never `alert()`. Toasts show above an open modal dialog: the toast container is a manual popover re-shown with each toast, so it is the newest thing in the top layer.

**Confirm with `confirmDialog`, never `window.confirm()`.** The Mac app's webview shows no JavaScript dialogs (`confirm()` answers false at once). `await confirmDialog({title, message, confirmLabel, destructive?})` resolves true or false from one `<confirm-dialog>` (built on `<app-dialog>`) mounted on `document.body`: Escape and the backdrop cancel, and focus starts on the confirm button, so Enter confirms, except with `destructive`, where it starts on Cancel (Enter cancels), as in `delete-task-dialog`. Tests answer it with `setConfirmHostForTesting({open})`.

`action-menu-presenter` opens a touch menu from a long press's anchor (the pressed item's rect and the touch point). `touchMenuPlacement` puts the menu below a short item (up to 120px, such as a row), or above when there is no room. Taller items, and items that leave no room either way, get the menu just above the touch point. It aligns the menu to the item edge nearer the viewport side and sets the transform origin where the menu meets the item. The presenter positions the panel after the popover is shown and measured, then springs its scale, opacity, and backdrop in. `close()` resolves the dismissal and dispatches `action-menu-dismiss` at once, so callers and the pressed item respond immediately, while the menu springs back out without intercepting pointer input before it is removed. Reduced motion skips both springs.

Delegate popovers render `session-list-item` rows inside another session row. Their activation handler must retain its own element binding and stop the nested `info-card-activate` event before it reaches the containing row; the resulting `select-session` event still bubbles for navigation. Native popovers display in the top layer but remain DOM descendants, so card hover styling is scoped to the direct primary control rather than the entire card subtree.

### components/

Feature and domain Lit custom elements that own rendering and user interaction. Import from `models/` for data, from `controllers/` for lifecycle-managed behavior, and from `ui/` for shared presentation primitives.

```
components/
├── changes/             Review surface components
│   ├── review-diff-panel.ts, review-file-diff.ts
│   ├── diff-file-tree.ts, diff-file-action-buttons.ts
├── file-browser/        The file browser feature: overlay, its tree and file search
├── file-viewer/         The file viewer feature: one file, the `file` view's pane and the file browser's content
├── app-inspector.ts     <app-inspector>: the Inspector's tab strip, rendering registered views
├── view-mount.ts        <reins-view-mount>: mounts, updates and disposes a view wherever one is shown
├── decorated-text.ts    A user message's plain text with decorators applied
├── tools/               Tool-specific chat renderers
│   ├── read.ts, edit.ts, write.ts, bash.ts
│   ├── create-task.ts, delegate.ts, generic.ts
│   ├── index.ts (registry), types.ts
├── app.ts               Root shell: lifecycle, route outlet, and global overlays
├── app-workspace.ts     Routed workspace: panes, responsive layout, and workspace-local state
├── project-history.ts   Routed full-screen project History page
├── settings/            Routed settings page (page.ts) and its sections
├── chat-panel.ts        Message display + composer orchestration
├── message-action-menu.ts Touch/context-menu presentation
├── chat-composer.ts     Prompt input, autosize, image attachments, recognizing commands (run by CommandRegistry)
├── slash-suggest.ts     The composer's `/` suggestions: commands and skills
├── session-sidebar.ts   Sidebar layout
├── session-list.ts, project-sidebar.ts, project-form.ts
├── task-list.ts, task-detail.ts, task-form.ts
├── branch-indicator.ts, quick-open.ts, search-palette.ts
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
├── chat-history-controller.ts        Loading earlier messages, with the scroll anchor pinned meanwhile
├── scroll-anchor-controller.ts       Keeps the text at a scroll container's bottom edge in place when the container is resized or, pinned, when content is added above
└── inline-views-controller.ts        Renders decorated HTML and gives its view mounts their views
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

All built-in REST calls go through the resource-oriented `ReinsClient` from the shared `@reins/client` package (`packages/client`, [ADR-022](../adr/022-shared-api-client-package.md)), through the app's instance `api` in `models/api.ts` (for example, `api.sessions.get(...)`, `api.projects.create(...)`, and `api.diff.patch(...)`). The client privately owns paths and query construction, request serialization, response decoding (a success that is not the JSON expected is an error), typed HTTP errors (`ReinsHttpError`, imported from `@reins/client`), browser-resource URL construction, and `AbortSignal` forwarding. Callers do not construct endpoint descriptors or URLs. In the browser the client has no base URL: paths stay relative to the app's server. Uploads report progress through the XHR transport `models/api.ts` gives the client (`fetch` cannot report upload progress). Scripts and tests use the same client with a `baseUrl`.

Shared request/response DTOs remain backend-owned. The client imports them type-only from `@reins/backend/*`; frontend imports from `@backend/*` must use `import type`; oxlint enforces both with no runtime-import exception. Stores remain responsible for caching, retries, loading/error presentation, request generations, and reactive state. The client is Reins' own client for its HTTP API, not a plugin interface.

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
                    │  - builds the Reins SDK, registers features   │
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

- **AppStore** (`models/stores/app-store.ts`) — Application-lifetime composition and lifecycle context. It owns WebSocket connection state, `SessionCache`, `ConversationsStore`, `ProjectsStore`, `SettingsStore`, the project files API (`files`), what the Reins SDK is built over (the view, decorator and command registries, the one `Inspector`, and `open`; *The Reins SDK*), and reconnect/resume reconciliation orchestration. It does not expose domain mutation facades, interpret inbound message kinds or routes, or own the active workspace. Scoped stores register reconciliation work with it so browser resume and reconnect use one coordinator without introducing an event-forwarding bus.
- **WorkspaceStore** (`models/stores/workspace-store.ts`) — Route-scoped active-session and workspace coordinator owned by `app-workspace`. It owns `ActiveSessionStore`, `DiffStore` and `CodeReviewStore`, shows the app's `Inspector` and tells it the viewed session's source (*Views and the Inspector*), derives `source` (an SDK `Source`: node and path) from the active session's placement, refreshes the diff when the files API says that source's files may have changed, subscribes directly to workspace-owned inbound message kinds, and filters session-scoped messages to its current session. WebSocket file-open paths are normalized here before a UI intent is dispatched. Every session change synchronously clears diff/review scope, resolves canonical session metadata and the task branch, then commits both scopes only if its transition is still current. A superseded transition may populate long-lived caches but cannot update workspace selection, diff, or review state.
- **DiffStore** (`models/stores/diff-store.ts`) — Git diff domain state, lightweight changed-file polling, raw patch loading, diff-mode selection, and branch synchronization. File-list, patch, and spread requests are generation-guarded so responses or errors from superseded project/branch scopes cannot restore stale data or diagnostics. Context expansion state belongs to the review model rather than the store; rendering concerns such as syntax highlighting stay in controllers/components.
- **CodeReviewStore** (`models/stores/code-review-store.ts`) — Synchronizes raw `CodeReviewState` for the viewed session's exact project/task scope and owns loads, optimistic annotation writes, submission, revision-aware invalidation reloads, and notifications. Pure functions in `models/code-review.ts` project saved annotations and build anchor evidence without wrapping transport state in another object. The panel's `InlineReviewController` owns one selection and composer across virtual remounts and exposes one per-file interface to the diff UI. Submission receives the selected session identity at action time; runtime activity remains owned by `SessionCache`.
- **SessionCache** (`models/stores/session-cache.ts`) — Canonical client cache for server-provided session metadata and the sole frontend owner of runtime activity. Stores and components derive running/activity views from it rather than duplicating activity in conversation or component state. `entries()`, which every list and activity selector iterates, leaves out background sessions; `get(id)` still returns them.
- **ActiveSessionStore** (`models/stores/active-session-store.ts`) — Route-scoped facade for the selected session. In addition to conversation actions and observation policy, it owns the selected session's normalized context snapshot. REST is the sole context source on route load, reconnect, and model change; existing canonical-entry and compaction-completion events coalesce refreshes, while a 10-second poll runs only when the running conversation is meaningfully observed. The last known snapshot remains visible while compaction is in progress, and request generations reject stale responses.
- **ConversationsStore** (`models/stores/conversations-store.ts`) — Keyed per-session conversation presentation state that survives route changes and missed streaming events. Durable AgentHarness `entry_added` events and REST pages use the same canonical `ConversationEntry` envelope: harness `id`, harness `parentId`, harness `seq`, optional Reins `clientId`, and a content-only `AgentMessage`. Both sources enter one idempotent ID-keyed upsert path. Optimistic inputs live in a separate insertion-ordered map keyed by `clientId`; a canonical envelope removes only its exact pending input. Submission-derived render keys remain stable through optimistic, durable-event, and page transitions, preserving send animation DOM identity. Streaming assistants are separate overlays keyed by the required runtime `streamId`; `message_end` can attach the durable entry ID so canonical insertion removes exactly that overlay. The pure reducer (`models/chat-state.ts`) replaces an overlay with any event that carries a full message (`message_start`, `message_end`, a keyframe `message_update`) and otherwise applies the update's step to `content[contentIndex]` with Pi's semantics (text and thinking deltas append, tool-call deltas append the raw argument JSON to `partialJson` while parsed `arguments` wait for `toolcall_end`, `*_end` is authoritative; see session-runtime.md *Streaming message updates*). A delta for an unknown stream changes nothing, and a step that does not fit the overlay's content marks it `stale`. Each `event` frame carries the session's `seq`; any jump (missed events, including across a WebSocket reconnect, or a restarted server counting from 1) marks the session's overlays stale. A stale overlay keeps its content and ignores deltas until the next keyframe (within about a second) or `message_end`. No-op events preserve state identity. Events apply to state immediately, but streaming partials (`message_update`, `tool_execution_update`) notify a session's listeners at most once per animation frame (with a 1s timeout fallback, since hidden tabs run no frames); every other change, including `message_start`, `message_end`, `entry_added`, `agent_end`, and seq-gap staleness, notifies synchronously and absorbs any pending frame. `flushNotifications()` delivers pending frames synchronously for tests. Partials for sessions with no listeners update state without scheduling anything. `get()` returns a view memoized per state object, and rebuilds `messages` only when `entries` or `pendingSubmissions` change and `streamingMessages` only when overlays change, so a streaming update leaves transcript `Message` objects identical and keyed `repeat` skips those rows. While a message streams, `<markdown-content>` renders settled block segments (split at blank lines outside fences, `$$` math, lists, and indented blocks; `models/streaming-markdown.ts`) that are parsed once, plus a re-parsed live tail; the unsplit render after streaming ends is authoritative, and code highlighting and mermaid wait until then. `agent_end` clears overlays and reports errors but never promotes another transcript. Compaction summaries appear only as canonical entries. There is no peer-message, FIFO, timestamp, or transcript fallback path. Stale/overlapping pages, reconnects, race ordering, and earlier-history loads therefore cannot consume unrelated state. Tool execution overlays remain keyed by tool-call ID, while persisted tool results are associated with their matching calls. Runtime activity remains solely owned by `SessionCache`.
- **ProjectsStore / ProjectStore** (`models/stores/projects-store.ts`, `models/stores/project-store.ts`) — Long-lived project/sidebar task and session list ownership plus project, task, and session-creation mutations. `ProjectsStore` is the aggregate interface: it hides child-store lookup policy, owns cross-project mutations and task/session creation, consumes task/session update subscriptions, and updates `SessionCache` as needed. `ProjectStore` retains one project's list state and detailed mutation implementation, including optimistic rename and explicit pin/archive updates with rollback. Route-scoped `WorkspaceStore` methods may add active-project context or route cleanup, but delegate domain work directly to `ProjectsStore`. Activity and session metadata are derived from `SessionCache` instead of stored redundantly. Normal lists exclude archived sessions and completed tasks. Background sessions are never listed or badged: the server leaves them out of lists and the activity snapshot, and a background session that reaches `SessionCache` through its detail view (e.g. after `session_updated`) stays out of `entries()`.
- **ProjectHistoryStore** (`models/stores/project-history-store.ts`) — Page-owned state for one project's full-screen History page. It composes independently paginated and searched session/task resource requests, loads completed-task conversations on demand, and owns optimistic unarchive/rollback. `project-history` creates, loads, subscribes to, and disposes this store from its `projectId`; neither `AppStore` nor the sidebar's `ProjectStore` knows about History data.
- **QuickOpenStore** (`models/stores/quick-open-store.ts`) — Shared quick-open data, filtering, recency state, and session activity lookup through the application `SessionCache`. It subscribes to activity changes so an open palette rerenders indicators without a shell callback. Overlay open/closed state remains component-local.
- **ProjectFiles** (`models/stores/project-files.ts`, `AppStore.files`) — The project files API, which is the SDK's `files` itself (reins-sdk.md *Capabilities*): raw capabilities over a source's files, which features build their own state on. A `Source` is a checkout named by its node and path (session placements carry no source ID). It finds how to reach a source and whether its node is connected from the sessions `SessionCache` places on it (their project's file routes; available when one of them is placed on a connected node and not removed), cached until the session cache changes; a source no known session is on has no listing, `contentUrl` is null and reads reject. `listing(source)` is the file listing as a `Loadable`, cached for the two sources asked for last (the viewed session's and the file browser's, which can differ; fewer would make the two drop and reload each other's listing on every render), loaded the first time it is asked for while the node is connected (idle, without files, while it is not), marked stale when the node comes back or on the change signal (listeners told) and reloaded on the next ask, so a source nobody shows costs no requests, with a request generation per source so a superseded response cannot land; a listing that comes back unchanged keeps its `data` array, so what is built from it is kept too. `subscribe` hears listings change. `read(source, path)` reads a file uncached (`FileText`; a `FileReadError` for a missing or unreadable file), `listDirectory` lists one level, `contentUrl` is a file's own URL. `onFilesChanged(listener)` is the change signal: a file-modifying tool (`write`, `edit`, `bash`) or a turn (`agent_end`) of a session ended, mapped to that session's source through `SessionCache` placements (nothing when the placement is unknown), announced 500 ms after the first such event so a burst refreshes once; a cached listing of that source is marked stale and listeners told, so whoever shows it asks again and reloads it. It hides which route reads which source: the project file routes read the project's default source (node-contract.md *Which checkout a call works in*), so only it changes once a route reads a source by node and path.
- **FileBrowserStore** (`models/stores/file-browser-store.ts`) — The file browser feature's state, created and owned by `app-shell`, over the SDK's `files` and `workspace` (`reins`): whether the browser and its file search are open, the source they are open for, the file it shows (`view`, a `file` view with the lines and Code/Preview choice it was opened with, a new object per open), the directory tree and the search's query and results (fuzzy-filtered from the source's listing), and opening the shown or a found file in the Inspector. Opening and closing keep all of it; opening for another source starts over and drops the earlier source's responses. Opening at a path gives a new `view` (which its file viewer reads again) and expands the tree to it; on the change signal for its source it lists its directories again.
- **ModelRegistryStore** (`models/stores/model-registry-store.ts`) — Provider/model registry data and derived selectors. Settings UI uses the instance owned by `SettingsStore`; other features may own their own registry instance when their data lifecycle is independent.
- **SettingsStore** (`models/stores/settings-store.ts`) — Persisted settings, auth/OAuth mutations, the settings page's model registry loading, and successful settings-change callbacks. `AppStore` owns the shared instance so app-wide preferences and the settings page stay in sync. Settings saves run in the background; avoid adding `saving*` props or disabling setting controls for routine persistence. Settings components keep only form/view-local state such as drafts and the pairing step; `components/settings/page.ts` subscribes to store change callbacks and owns success toast copy. The page declares its sections (ID, label, description, `load`, `render`); a section loads its own data when it is shown, so the Models section passes only its keys to `SettingsStore.loadSettings(...)`.
- **NodesStore** (`models/stores/nodes-store.ts`) — The settings page's node list (each node's sources shown as a count), pairing-code creation and its progress, renaming (`renamingNodeId` while one is saved; the section's dialog keeps the typed name) and removal, owned by `SettingsStore` (`nodesStore`). A created pairing code is held only until dismissed (or the Nodes section unmounts); the server keeps only its hash, so it cannot be fetched again.

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

Thin WebSocket wrapper for receiving server messages. Its inbound API publishes the original typed discriminated message envelope and accepts a typed handler map keyed by message kind. It filters delivery but does not decide how messages affect UI state. It sends only the heartbeat.

## Session operations (`models/session-operations.ts`)

`SessionOperations` (`AppStore.sessionOperations`) sends a session's operations to the server over HTTP (`ReinsClient`). A session's submissions, model changes and compactions go one at a time, each once the server answered the one before, so they reach the server in the order they were made (the server applies them in arrival order, session-runtime.md *Submission and ordering*); other sessions' commands do not wait, and abort goes at once. `submit(sessionId, op, content)` shows the input in the conversation at once (an optimistic entry under a new `clientId`) and returns it with `admitted`, which resolves once Pi committed it. A submission the server did not answer (a network failure, or a 503 during a reload's gap) is sent again under the same `clientId`, after 1 s, doubling to at most 10 s, until it is answered: the server converges on a repeat. Later commands of the session wait for it. A refusal removes the entry, shows `"<op> failed: <message>"` as the conversation's error (`ConversationsStore.rejectSubmission`) and rejects `admitted`. `ActiveSessionStore` (the composer) and the SDK's `sessions` (`SdkSessions`) both submit through it.

Aggregate and scoped stores subscribe directly only to the message kinds they own: `ConversationsStore` owns conversation traffic and scoped errors, `ProjectsStore` owns task/session list invalidation, `NodesStore` (through `SettingsStore`) owns node messages (`node_updated`, which names the pairing code on a redemption, and `node_removed`), `ProjectFiles` turns file-changing session events into its change signal, and `WorkspaceStore` owns review and file-open reactions for its mounted scope. `AppStore` consumes connection state and coordinates reconnect/resume reconciliation, but is not an inbound message router. Components never subscribe to the WebSocket source.

### Activity indicator semantics

Session activity is server-authoritative and enters the frontend through `SessionCache`. Project/session views derive activity indicators from cached session metadata rather than raw runtime events or duplicated component state.

Running indicators remain visible while the agent loop is active. Finished indicators represent unread completed work and are cleared automatically only when the selected session's conversation is meaningfully visible: the document is foregrounded and the Chat surface is on screen (on mobile, Chat must be the active workspace page). Changes and other mobile pages do not count as viewing the conversation. Successfully reported child sessions are the lifecycle-owned exception: they clear directly after their result is admitted to the parent, while failed parent delivery leaves them finished/unread. `ChatPanel` reports whether its foreground conversation is meaningfully observed directly to its route-scoped `ActiveSessionStore`. The store owns the resulting policy: entering observation clears pending finished activity, completions are auto-read only while observed, and explicit unread intent is preserved until observation restarts or new work begins. It knows only the observation fact—not which app pane produced it—and serializes active-session read/unread requests. `ActiveSessionStore` owns the active session's read and unread operations, while idle sessions can also be marked unread through their project lists. Explicitly marking the open session unread is preserved until the conversation is viewed again or new work completes visibly. Reconnect/resume flows reconcile from the server snapshot instead of trusting missed client events.

## Routing (`routing/router.ts`, `routing/app-router.ts`)

`FrontendRouter` is a small registered hash router and page registry. Core routes are registered by `createAppRouter()`:

- `#/session/:sessionId` — view a specific session
- `#/new`, with optional `?project=` and `&task=` (a task only with a project) — the new session page (`<new-session-page>`, `components/new-session-page.ts`), shown in the workspace's chat pane in place of a session. It creates nothing until its first message is sent: then it creates the session with the chosen model, as `sessions.create` does, uploads the message's attachments and submits it. A session it created is reused for the same project and task when a later step failed, and a model chosen after it was created is set on it with `PUT /sessions/:id/model`. Once the message is sent, the page hands it to the session's chat panel (`AppStore.sendHandoff`, `models/send-handoff.ts`), which animates it from the page's composer into the conversation, and replaces its route with the session's. Its pickers replace its URL, so the URL is the source of its choices
- `#/projects/:projectId/history` — view a project's full-screen History page
- `#/settings` and `#/settings/:section` — the full-screen settings page; the section must be one of `SETTINGS_SECTIONS`. Both render one shared template, so the page stays mounted while sections change. `openSettings()` records where it was opened from, `showSettingsSection()` replaces the history entry, and `closeSettings()` goes back there in one step (or to `#/` when settings was opened from its URL)
- empty or unknown hash — render the workspace with no selected session

The URL is the main area's state: opening a view there (`workspace.open`) and the new session page's pickers change the URL, and the view shown is parsed from it, so reload, Back and links show the same view. What is not in it is a draft or a visit's state: a composer's text and images, the new session page's model, scroll positions, the mobile pane, and the Inspector's tabs (a container of their own).

Route definitions declare a stable name and path pattern with named parameters, optional parameter validation, and a `renderPage` callback. A hash's query parameters are route parameters too (a path parameter of the same name wins), and `hash()` puts the parameters its pattern does not name in the query. Empty/root, session and new session routes render the main workspace, with one shared template so it stays mounted while they change; `mainViewOf(route)` and `mainViewHash(view)` map them to the main area's views (`session`, `new-session`) for the SDK. `mainViewOf` gives one object per route object, which `app-shell` keeps until the URL changes, so a view is a new object only when its URL is: the app rendering again (any store change) gives the page the same view, and a new view object stays what it is everywhere, an open of the view (reins-sdk.md *Contribution points*); History and settings render full-screen pages. Register future page routes with `router.register(...)` rather than adding parser or route-outlet conditionals; plugin-owned routes use the same registry with a namespaced route name, so matching, canonical hash construction, and page rendering remain one extensible seam.

`AppRouteController` is a route-agnostic browser/Lit lifecycle adapter. It listens for `hashchange`, restores and persists the last hash, resolves through the registered app router, reports every resolved `Route` through `onRouteChange`, and requests a host update. It does not interpret route names, invoke semantic route operations, or know about sessions. `app-shell` owns the active page route; its route-change handler assigns the resolved route and records quick-open recency for session routes. AppStore is intentionally absent from route interpretation and workspace selection.

The shell passes the long-lived application context plus the routed session ID to `app-workspace`. `app-workspace` creates and disposes its `WorkspaceStore`; `WorkspaceStore.setSession()` applies that page-scoped route input to session metadata, project context, task branch, diff scope, and review scope without becoming a routing API. Project pages own their page-specific stores. The chat panel is rendered with `keyed(store.sessionId, ...)` so switching sessions remounts per-session ephemeral UI while long-lived conversations and caches survive workspace/History navigation.

### Last-viewed hash restore

The router module provides `getLastHash()` and `saveHash()` helpers backed by `localStorage` (`reins:last-hash` key). `AppRouteController` saves `location.hash` on every `hashchange` event, and restores any registered route on fresh page loads when no hash route is present. This is a pure routing concern. If a stored session route points to a deleted session, the normal fetch-404 handling shows the empty state.

## Component structure

`app-workspace` receives the application-lifetime AppStore context, owns one WorkspaceStore for its mounted route lifetime, and renders one canonical named pane set (`sessions`, `chat`, `changes`, `inspector`) into a single responsive workspace DOM. Keep that routed workspace—and especially `session-sidebar`—mounted across session route changes, including while selected-session project metadata is loading; only session/project-scoped pane content should change identity. The workspace grid is a four-page mobile swipe surface (`sessions → chat → changes → inspector`) and becomes a desktop CSS grid at the `md` breakpoint (`sessions | chat/changes | inspector`) via responsive classes. Chat and Changes each render their own main toolbar in their mobile page column so the toolbar travels with the pane during swipes; at the desktop breakpoint those toolbars collapse into the same center grid header and only the active main-pane toolbar is shown. Workspace navigation uses named `WorkspacePane` values rather than mobile page indexes; only `WorkspacePages` (`models/workspace-pages.ts`, *Mobile workspace swipe*) translates between panes and mobile page numbers.

```
app-shell                    — root lifecycle, route outlet, global overlays; builds the Reins SDK and registers the built-in features
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
│   ├── app-inspector        — the Inspector's tab strip; renders each tab's view
│   │   ├── diff-file-tree       — the `diff-file-tree` view (the Changes tab), registered by app-workspace
│   │   └── reins-view-mount     — a registered view's tab, mounting its `pane`
│   │       └── file-viewer          — the `file` view's pane (the file viewer feature)
│   │           └── file-viewer-content
├── project-history          — registered full-screen project History page
├── settings-page            — registered full-screen settings page, one section at a time
├── quick-open               — Cmd+K session search overlay
├── file-search              — Cmd+P file search overlay (the file browser feature)
└── file-browser             — file browser overlay (the file browser feature)
    ├── file-tree
    └── file-viewer
        └── file-viewer-content
```

All components live under `components/`. Sub-directories (`changes/`, `tools/`, `file-browser/`, `file-viewer/`) group related components.

### Desktop pane layout

`app-workspace` owns the stable `sessions` and `inspector` side-pane widths and sidebar collapse through `WorkspaceLayout` (`models/workspace-layout.ts`). The single workspace surface retains the same pane DOM while CSS custom properties size desktop columns; resizing never rekeys Chat or Changes. Desktop-only separators accept pointer drags, arrow-key steps, and Home/double-click resets. The Inspector's width is per view name: before each render `app-workspace` tells the layout the active tab's view name and its pane's `width` (`showInspectorView`), and resizing or resetting changes only that name's saved width. It re-renders when `app.views` changes, since a renderer registered later can change the shown view's width. On desktop a new width glides (a CSS transition on the surface's `grid-template-columns` and the dividers' position, in `app.css`), except while a divider is dragged: the shell has `data-resizing` then, so the pane follows the pointer at once. Layout is saved locally per browser device and invalid values fall back to defaults; narrow windows reserve center space. The mobile four-page grid and swipe order remain independent of saved desktop dimensions. This is a host-owned layout seam, not a plugin contract or docking system.

### The Reins SDK

Built-in features get what they use through the Reins SDK ([reins-sdk.md](reins-sdk.md); ADR-030): `files`, `sessions`, `workspace.open`, `views.register`, `messages.registerDecorator` and `commands.register`. `app-shell` builds it over `AppStore`, an `SdkSessions` (`sdk-host/sessions.ts`) and the main area (its `app-workspace`, which tells what it shows, and the router, as it navigates, which `AppStore` does not) with `createReinsSdk` (`sdk-host/create-sdk.ts`), calls the register functions with it (the file viewer, file references, the `/compact` and `/new` commands) and creates the file browser's `FileBrowserStore` with it. Features import only `@reins/sdk` and their own modules. App code (`app-workspace`, `app-inspector`, messages, the composer) never sees the SDK: it uses what the SDK is built over, `AppStore.views` (`ViewRegistry`), `AppStore.decorators` (`DecoratorRegistry`), `AppStore.commands` (`CommandRegistry`, which `app-workspace` gives `chat-panel` and it its `chat-composer`) and `AppStore.inspector`.

### Views and the Inspector

A **view** (`View` in `@reins/sdk`) is a plain, serializable object whose `view` field names what it shows: `{ view: "diff-file-tree" }` (the Changes tab), `{ view: "file", source, path, startLine?, endLine?, mode? }` (`mode`: the Code/Preview choice). A view about something fixed names it (a file names its source); a view that follows the viewed session reads the context instead. The SDK names no views: a feature registers its view's name at runtime, defines its parameters' type (`FileView` in `components/file-viewer/file-viewer.ts`) and adds it to `ViewTypes`, which only TypeScript reads (reins-sdk.md *Where it lives*). Its identity is `ViewRegistry.keyOf(view)`: its name and its renderer's `key` (a file's source and path), which the Inspector (`new Inspector(views)`) uses to find an open tab. Renderers are registered through the SDK (`views.register`, into `AppStore.views`), with a mount function per presentation (ADR-030): a `pane` (with the tab's title, description, icon presentation and width) for the Inspector, an `inline` one for message decorations. `{ view: "file-reference", source, path, startLine?, endLine? }` is shown only inline. The `diff-file-tree` view is registered by `app-workspace` over its diff and review stores (reins-sdk.md *Views over the app's state*).

**`workspace.open(view, { in? })`** shows a view in a container named by ID (`ContainerId`: `"inspector"` or `"main"`). The main area navigates (today only to a `session` view, declared by `app-workspace`, by its route; reins-sdk.md *Capabilities*); `AppStore.open(view, "inspector")` opens a view in `AppStore.inspector`. The Inspector (`Inspector` in `models/inspector.ts`) is the app's one set of tabs: the `diff-file-tree` tab (Changes) first and never closable; `open` adds a tab or focuses the one with the same key and replaces its view with the one opened (nothing is merged: a new object every time); closing the active tab focuses the one before it. It tells `subscribe` listeners about every change and `onOpen` listeners about each view opened: `WorkspaceStore` notifies on its changes, and `app-workspace` moves to the Inspector page on a phone when a view opens. `WorkspaceStore` tells it the viewed session's source (`setViewedSource`); when that changes to another source, every closable tab closes (a provisional policy: workspace-inspector.md *Slice 2e*). Tabs are not saved.

`app-inspector` (`components/app-inspector.ts`) renders the strip and every tab's content, hiding all but the active one, so a file keeps its scroll position and Code/Preview tab. Its titles and icons come from the registered renderers (`views`, the `ViewRegistry`, which it subscribes to): each tab's icon is a `<reins-view-mount>` of its pane's `icon` presentation; for a registered view with a `pane` it renders a `<reins-view-mount>` (`ViewMount`, `components/view-mount.ts`) given the pane, the tab's `view` and `context` (the viewed session's source, one object while it is unchanged), which mounts the view while the tab exists and updates it with a new view object or context; a view without a `pane` shows as unavailable. The Inspector knows no view by name. The `file` view's pane mount (`registerFileViewer`, `components/file-viewer/file-viewer.ts`) creates a `<file-viewer>`, gives it the SDK's `files` and its `view`, sets a new `view` on `update` and removes it on dispose.

**The file viewer** (`FileViewer`, `<file-viewer>`) shows one file of a `file` view: a header with its path, a download link and an action to open it in the other container (`container`: in the Inspector, *Open in file browser*, the `open-in-browser` event; in the file browser, *Open in Inspector*, the `open-in-inspector` event, which the browser handles), over `file-viewer-content`, which picks the renderers for the file's type and shows Code/Preview tabs. The Inspector's file tabs and the file browser both show one. It loads its file itself, with a `FileLoader` (`models/file-loader.ts`) over `files`: it reads it when it mounts, again whenever it is given a new `view` object (an open) and when the change signal names its source, keeping the old content shown meanwhile, and drops a response for a file or source it no longer shows. It turns the view's lines into a new `HighlightRequest` per view object, and its `mode` into the Code/Preview tab (Code when there are lines). It keeps the tab the user chooses (`file-viewer-mode-change`, from `file-viewer-content`), and both actions carry it with the lines (`shown`). **Line highlights are requests:** `file-viewer-content` and `file-viewer-code` apply a `HighlightRequest` once per object, then keep the user's own gutter selection; re-rendering with the same object changes nothing, and a new object highlights and scrolls again, even for the same lines.

**The file browser and file search** are a feature of their own (`components/file-browser/`, `FileBrowserStore`), created and mounted by `app-shell`, unconnected to the workspace. They are opened for a source: `open-in-browser` (`{source, path, startLine?, endLine?, mode?}`, heard on `document`: tool results, diff buttons, an Inspector file tab's folder button, the server's `open_file` through `WorkspaceStore`), `open-file-browser` (the toolbar) and `open-file-search` (⌘/Ctrl+P), each naming the viewed session's source. Inside the feature, the tree, search and close controls call the store directly. File search's `palette-alternate-confirm` (⌘/Ctrl+Enter, from `search-palette`) and its rows' Inspector buttons (`openFoundInInspector`), and the file browser's **Open in Inspector** (`openInInspector`, given the file viewer's `open-in-inspector`, with the file's lines and Code/Preview tab) call `workspace.open` with a `file` view of the browser's source. The browser stays rendered, hidden, while closed once it has shown a file, so its file viewer keeps the file and its scroll position.

### Message decorations

Completed message text is decorated: views are shown in place of pieces of it, such as file references that open in the Inspector ([workspace-panes.md](../features/workspace-panes.md) *File references in messages*). Decorators register through the SDK (`messages.registerDecorator`; reins-sdk.md *Contribution points*; ADR-030): a `MessageDecorator` finds its pieces in prose (`decorate`) or decides a whole inline-code span (`decorateCode`), synchronously, each naming a view, and says when its data changed (`onChange`). The view is shown in its `inline` presentation and controls the piece: the app decides where decorating happens, keeps the fallback text, and runs the view's lifecycle. `BoundDecorators` (`sdk-host/decorators.ts`) holds the registered decorators bound to a source: their context filled in, not filtered, so they are applied to text alone (what they find are the decorations): `segments(text)` splits prose into plain runs and `InlinePiece`s (a view, its inline presentation from the registered renderers, and its `InlineContext`: the source, the piece's `text`, `code` and `original()`; an earlier decorator wins an overlap; spans outside the text and views without an inline presentation are dropped), `plainText(text)` does so for user messages, which are not Markdown, leaving fenced code blocks alone, and `code(text)` decides inline code. `DecoratorRegistry.bind(source)` (`AppStore.decorators`) returns the same object until a decorator or a renderer changes or the source does, so rendered messages keep their parsed HTML.

**File references** are the first decorator, with the `file-reference` view (`registerFileReferences(reins)`). `FileReferenceIndex` (`extensions/message-file-references/message-file-references.ts`) is built from the source's listing (from `files`) and the source, whose path is the checkout's, and its views carry the source: exact full paths, absolute paths inside the checkout, unique basenames, line suffixes, traversal and URL rejection, the longest reference in each word with surrounding punctuation left out. In prose (`find`) a reference also needs a `/` or a line suffix; a lone name resolves only as inline code (`resolveCode`). Lookups are hash lookups per word, cached per index; the decorator keeps one index per listing, so caches never outlive the listing they came from, there is none until the listing loads or while the node is offline, and it reports a change only when the decorated source's listing array changes (a refresh that finds the same files changes nothing). The view's inline mount (`referenceMount(reins.workspace)`) draws `original()` inside a `span.file-reference` with `role="button"`, `tabindex="0"` and the label as its tooltip, which opens the file (a `file` view of the reference's source) on a click, Enter or Space.

`app-workspace` gives `chat-panel` the registry as `decorators`. `chat-panel` subscribes to it (a `StoreController`) and gives each `chat-message` `decorators.bind(source)`: a new object after a change, which is what makes the messages parse again, since the registry itself is one object for the app's lifetime. `chat-message` gives it, as `decorators`, to the text it decorates (not the compaction summary). Decoration is presentation only; persisted messages, provider history, copied Markdown and compaction input never see it. `models/decorated-html.ts` applies them to text, and `controllers/inline-views-controller.ts` puts the result on the page:

- **Markdown** (assistant text, session updates): `decoratedMarkdown(text, decorators)` lexes with marked, replaces `text` and `codespan` tokens holding pieces with `decoration` tokens (never descending into code blocks, HTML, links or images), and renders them through a marked extension as `<reins-view-mount data-piece="N">` around the original text, `N` indexing the result's `pieces`. `<markdown-content>` takes `decorators`, ignores them while `streaming`, and memoizes the `DecoratedHtml` per text and decorators.
- **User text** is not Markdown: `chat-message` renders `<decorated-text>` (`components/decorated-text.ts`), which renders `decoratedPlainText(text, decorators)`, the escaped text with the same view mounts.
- **Giving view mounts their views**: the HTML is rendered with `unsafeHTML`, where a template cannot bind properties, so both elements render it through an `InlineViewsController`, which after each update that rendered new HTML sets each view mount's `presentation`, `view` and `context` from its piece. From then on the view mounts run the lifecycle themselves: they keep their properties, so a message that leaves the page and comes back mounts its views again without parsing or rendering again.

### Mobile workspace swipe

`components/app-workspace.ts` owns workspace rendering and delegates mobile swipe event wiring/state to `PageSwipeController` in `controllers/page-swipe-controller.ts`. The workspace uses a single inner `.workspace-surface` grid as the layout authority: mobile translates the four full-width page columns (`sessions → chat → changes → inspector`), while the `md` breakpoint changes that same grid to the desktop columns. **Each Inspector tab is a page of its own.** The pages are a pure model, `WorkspacePages` in `models/workspace-pages.ts`, built from the mobile pane order (`MOBILE_WORKSPACE_PANE_ORDER`) and the app's `Inspector`: `count` is the pages before the Inspector plus its tab count, `pageOf(pane)` gives the Inspector's page as its active tab's, `at(page)` gives a page's pane and the Inspector tab it shows (which committing to it focuses), and `offsets(page, translateX, width)` splits a drag between the surface and the Inspector. `app-workspace` builds one per use and hands its answers to `PageSwipeController` (`pageCount`, `getPage`, `commitPage`) and to rendering; it holds no page arithmetic. Everything follows the Inspector's place in the order, so a different order changes the pages without new arithmetic. The surface never translates past the Inspector column; the rest of a drag goes to `app-inspector` as `swipeX`, which moves a track of the tabs' panels laid side by side (stacked and hidden at the `md` breakpoint), so the tab strip stays in place while the content slides. Inactive panels are `inert`. The outer workspace shell only clips overflow and hosts pointer listeners; keep it `overflow-clip` so it never becomes a restorable scroll container that can desync the visible mobile page from `activePane`. Do not add a second desktop grid wrapper around the surface. The controller owns page-specific behavior — page clamping, edge resistance, release thresholds, translate targets, and page commits — and creates one short-lived `Swipe` instance from `models/swipe.ts` per pointer-driven swipe. The swipe instance lasts from accepted `pointerdown` through drag classification, release/cancel spring animation, click suppression, and completion; keep per-swipe mutable state there rather than adding reset-heavy gesture fields to the Lit component. The shared scalar spring animation lifecycle lives in the one-shot `Spring` class in `models/spring.ts`; its stiffness and damping can be tuned per instance while omitted values retain the shared defaults. Swipe-specific pointer classification and DOM opt-out predicates stay private to `models/swipe.ts`.

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

Tool calls in the chat panel are rendered by tool-specific renderers rather than a generic JSON dump. Each tool (read, bash, edit, write, create_task, delegate) has a dedicated component in `components/tools/` that owns its full visual output. Pure data-extraction helpers live in `models/tools/`. A registry in `components/tools/index.ts` maps tool names to renderers, falling back to a generic renderer for unknown tools. Renderers receive `ToolBlockData` plus a narrow `ToolRenderContext`; the workspace threads only the viewed session's `source` through the chat hierarchy so file tools normalize paths and open the file browser for that source without ambient workspace state.

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
- `diff-file-tree.ts` — Collapsible changed-file tree with item-ID navigation and diff-mode selection; the Inspector's `diff-file-tree` view (`registerDiffFileTree`, registered by `app-workspace` over its stores). It highlights `DiffStore.activeFile`, which the diff review sets with `active-file-change`.

`DiffStore` owns the diff lifecycle and exposes raw `/diff/patch` text (`patchData`) as a `Loadable<T>` value. `ReviewDiffPanel` parses it into renderer-owned records. Collapse markers are keyed by project, branch, item, and reviewed content. The retired parsed JSON diff payload is not loaded or exposed.

The Changes surface's geometry, mounting, navigation, anchoring, measurement, and cleanup contracts are defined in [review-virtualization.md](review-virtualization.md). Generic virtual behavior belongs to `VirtualListController` and `VirtualListCoordinator`; review policy remains in `ReviewDiffPanel`. Pierre-backed renderers share one `WorkerPoolManager` from `pierre-worker-pool.ts`, while the review `FileDiff` and standalone file source renderer also share `PierreRenderer` for ref mounting, input reconciliation, completion, and cleanup. Their theme variables live on `<diffs-container>` hosts in `app.css`; only selectors that target shadow-DOM internals remain renderer-local. The file viewer's rich Markdown, HTML, image, PDF, and binary renderers remain outside Pierre. Tool output and Markdown code blocks continue to use the shared Shiki highlighter independently of the Changes renderer.
