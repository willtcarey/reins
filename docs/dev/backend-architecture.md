# Backend Architecture

The backend is layered with a one-way dependency direction:

```
routes / tools / ws / nodes
            ↓
          models
            ↓
    stores + utilities
```

`src/nodes/` (the node link) is an adapter like the routes: it serves the node's calls and delivers the outbox through models, not stores.

## Layers

### Routes (`src/routes/`)

Thin HTTP adapters. Parse requests, call model functions, format responses. Error handling is via thrown `HttpError`s (see [router.md](router.md)).

Shared built-in HTTP DTOs live beside the route, model, or store that sends the data. The frontend and `@reins/client` may import these only as types (the client by package name, `@reins/backend/*`, which the package's `exports` maps to `src/`). Runtime endpoint construction and transport behavior belong entirely to `@reins/client` (`packages/client`), the one client of the HTTP API for the browser app, scripts and tests ([ADR-022](../adr/022-shared-api-client-package.md)); when a tool needs an endpoint, add it to the client beside the route. The backend does not publish endpoint descriptors or a plugin-facing client contract. An `/api` path no route matches is a JSON 404 (`handler.ts`; see [router.md](router.md) *Unknown routes*).

### Tools (`src/tools/`)

Agent tool definitions live on the node (`@reins/node/reins-tools`, assembled by the node's runtime builder). The server implements what they call: `tools/index.ts` (`serverToolCalls`) runs `script.execute`, `script.search` and `project.createTask` for the calling session, reached over the node link (`nodes/node-tool-calls.ts`; see node-contract.md *Agent tools*). Scope comes from the server's session row at call time, never from the caller.

**Current tools:**

- **`create_task`** — creates a task with a git branch. Available in all sessions. Optional `prompt` parameter kicks off a fire-and-forget session on the new task.
- **`search`** — discovers the curated `execute` API surface by returning documentation-only TypeScript interfaces from `src/scripting/api-registry.ts`.
- **`execute`** — runs an async JavaScript function body in a VM with only the curated `api` object in scope. Scripting functions live under `src/scripting/`; session-analysis helpers should extend `api.sessions` rather than introducing a separate analytics namespace. Keep `src/scripting/*` as execute/search glue: TypeBox schemas, descriptions/tags, project/task access checks, and delegation to stores/models. DB-backed filtering/extraction logic (for example session entry/message/tool-call extraction) belongs in `src/*-store.ts` so scripting is not the source of truth.

Session orchestration is exposed as `api.sessions.start/send/wait` through search/execute, not specialized delegation tools. `createSession(state, projectId, opts)` in `sessions/create-session.ts` creates sessions (the row, on its source's node, with its model frozen from the options or `default_model`; the node creates Pi's lane when it first opens the session); the server opens no runtime. Runtime assembly/cache is on the node (`packages/node/src/node.ts`, `packages/node/src/runtime/build.ts`). `new SessionInstance(state, callerSessionId)` (`sessions/session-instance.ts`) is the caller-scoped scripting API; it owns scope and child-depth policy, addressed prompt or steering submission to the outbox and bounded waits. A session's run (node lifecycle reports and their effects: activity, metadata, a child's report to its parent; crash recovery; waits over server projections) is `sessions/session-runs.ts`; whether a session is busy (`sessionActivity`, `activeSessionIds`) is read in `models/session-activity.ts`. Addressed sends always enter through native steering on the node so AgentHarness joins active work or starts/resumes idle work; there is no Reins-managed follow-up queue. The tool abort signal is passed only to bounded observation; cancelling a wait never invokes the target runtime's abort. See [node-runtime.md](node-runtime.md#session-orchestration).

A **background session** (`sessions.background = 1`, `createSession(..., { background: true })`) is a real session — outbox delivery, runs on its source's node, settlement, stored transcript, waits, child reports — that the browser never shows. Reins features (extensions, server features) start them; scripts cannot (`sessions.start` has no such option), though `sessions.list` can include them (`background: "only" | "include"`) and session results expose `background`. Server reads that feed the browser leave them out: `listSessions` (by default), `listPaletteItems`, `listSessionsWithActivity` (the activity snapshot) and `listTasks`' `session_count`/`session_ids`. Creating one is not announced (no `session_created`: the browser would list it before learning what it is); later broadcasts about them (`session_updated`, live events) are sent as for any session; the session detail view carries `background: true`, and the browser's `SessionCache` leaves such sessions out of `entries()`, which its lists and activity badges iterate (see frontend-architecture.md). Creating one does not touch its task's `updated_at`.

A session's **kind** (`sessions.kind`, `createSession(..., { kind })`, default `"agent"`) defines how it runs: its system prompt, its tools and whether the node appends its environment. The registry is `sessions/session-kinds.ts` (name → resolver of the opening commands' `runtime` from the session and task rows; `registerSessionKind`); the agent kind's prompt is `sessions/system-prompt.ts`. Kinds are validated in code (no DB constraint) and are not exposed to scripting. See node-contract.md *Session kinds*.

### WebSocket handlers (`src/ws.ts`)

Command dispatch for `prompt`, `steer`, `abort`. Prompt and steer messages are validated at the WS boundary and use block-only content (`[{ type: "text", text }]` plus optional image refs), then persisted to the node command outbox. WS does not expand skills or hydrate attachments; the node expands slash skills with the bound source cwd and hydrates attachments at the provider boundary. Abort is forwarded to the session's node; a session at rest on the server answers "Session not active".

### Models (`src/models/`)

Business logic: orchestrates stores, git operations, validation, and WS broadcasts. Model functions throw on failure — callers decide how to surface errors (HTTP status, tool error result, etc.).

WS broadcasts for state changes live here so every caller gets them automatically.

### Stores (`src/*-store.ts`)

Thin SQLite access. CRUD operations and queries, including DB-backed read projections used by scripting APIs. No git, no broadcasts, no business logic beyond what the DB enforces.

### Migrations (`src/migrations.ts`)

Migrations and outbox recovery run whenever a handler load opens the database (`openDb` in `src/db.ts`, called by `start` in `server.ts`): at process startup and, in dev, on every reload, once the previous load has stopped and closed its connection. Only pending migrations apply, so a new migration takes effect on the next reload.

Schema-only migrations can be SQL strings. Data migrations that need application logic (for example JSON tree rewrites, hashing, or BLOB creation) should live under `src/migrations/` and be imported into the same ordered migration list.

### Utilities

- `src/git.ts` — `Git`, one checkout's git operations (branch, checkout, refs, blobs, diff streams), run through an injected `Spawn` (`src/spawn.ts`): `RemoteNode.spawn` on a source's node (tests: `localGit`). Raw command runners stay private; add semantic methods instead of exposing them.
- `src/branch-name.ts` — branch-name slugification (`slugifyBranchName`: `task/<slug>`)

Stateless helpers that don't depend on other layers.

### Sessions, nodes and the node link

**The server never executes sessions.** Every session runs on the node of its source (`sessions.source_id`; see node-contract.md *Node hub*). The server holds no live runtimes: `ServerState` (WS clients, frontend dir and `state.nodes`) is built on every handler load (`createServerState` in `state.ts`): the clients are the process's, the hub is the load's own, and a dev reload closes the previous hub's node connections (the node redials; see hot-reload.md).

`src/nodes/` — everything about nodes on the server: the link to them, the command outbox, and the product handlers serving their calls. It reloads with the rest of the handler module. It is an adapter above models (see *Dependency rules*): the hub builds one `Nodes` and one `Sessions` once it is in use, from itself and the state's clients, and hands them to everything in `nodes/` that reads or changes a node or a session.

The link:

- `nodes/node-hub.ts` — the node links and dispatcher; calls product code directly (`nodeHandlers`, `sessionRoute`, `recoverLostRuns`, `onCommandDelivered`) with the state it belongs to and its models; a challenge's key is `NodeModel.publicKey`
- `nodes/node-handlers.ts` — the server's side of node→server calls (`nodeHandlers`: storage, lifecycle reports, attachments, credentials, tool calls; resolved once per connection, at hello, where `NodeModel.assertMayConnect` refuses a revoked node), fenced by the session's source being on that node; each call reaches its session through `Sessions.get` (a `SessionModel`)
- `nodes/server-peer.ts` — the server half of one node connection (hello, epochs, wire methods); `nodes/node-streams.ts` — its stream registry; `nodes/local-socket.ts` — the local node's Unix socket listener

The outbox:

- `nodes/node-command-store.ts` — the outbox table (the only code that reads or writes it); `nodes/node-command-recovery.ts` — startup recovery
- `nodes/node-command-dispatcher.ts` — outbox delivery chains and settlement (`deliverCommand`; `DeliveryDeferred` requeues)
- `nodes/commands.ts` — outbox delivery of prompt/steer/setModel: `sessionRoute` (a session's node, for the dispatcher), each command's wire call and outcome classification (requeue via `DeliveryDeferred`, node refusal, terminal), preserving typed wire results rather than inventing a second result vocabulary; what each carries is `SessionModel.context`
- `nodes/node-command-notifications.ts` — settled-command failure notifications, to the browser client that submitted an input (`observeSubmission`, held on the `WsClient`); a failed model change goes to every viewer (`Sessions.modelChangeFailed`)

Node→server calls:

- `nodes/node-storage.ts` — the server half of the node's `RemoteStorage`: `readStorage`/`commitStorage`, `SessionModel.readStorage`/`commitStorage` with Pi's refusals as `invalid_request`
- `nodes/node-credentials.ts` — credential reads and OAuth refresh for nodes
- `nodes/node-tool-calls.ts` — the server side of the node's Reins tools
- `nodes/node-session-events.ts` — a node's session reports: relays live events to browsers, hands `session.started`/`session.settled` to `sessions/session-runs.ts`

`src/sessions/` — a session's lifecycle on the server.

- `sessions/create-session.ts` — session creation (placed on the caller's source or the project's default source; of a registered kind)
- `sessions/session-kinds.ts` — the session kind registry: how each kind's sessions run (`runtime`: system prompt, tools, node environment); built in: `agent` and the `task-generator` utility kind
- `sessions/task-generator.ts` — task generation from freeform input (`generateTask`, `POST /api/projects/:id/tasks/generate`): a background `task-generator` session on the request source's node with the utility model, waited on (30 s), parsed, then deleted (row, transcript, outbox work) and closed on its node; any failure gives a deterministic task
- `sessions/system-prompt.ts` — the Reins system prompt of agent sessions (task or project-assistant section, orchestration)
- `sessions/session-instance.ts` — `api.sessions.start/send/wait` for one calling session: scope, child depth, submission and waits
- `sessions/session-runs.ts` — a session's run as the server sees it (`sessionRuns({ broadcast, nodes })`: `runStarted`, `runSettled`, `recoverLostRuns`, `waitForSettlement`; `latestSettlement`, `runInProgress`, `createResumeBudget`), all on the session row, the outbox and its storage. A child's report to its parent is submitted through `Sessions.submit` inside `runSettled`'s transaction
- `sessions/session-ownership.ts` — whether a node owns a session, moving a session between nodes, and telling the node of a deleted session to close it (`sessionsOnNodes`, `closeDeletedSessions`)

### Nodes and sources

`nodes` identifies execution hosts; `sources` binds a project to a host-local path. Migration `029` seeds one node row (`internal`, the ID the local node process announces by default) and gave every existing project a source on it. A new project's first source is created with it on the node its creator chose (`createProject`), and each source's path is edited on the source (migration `043` dropped the triggers that used to do both on the seeded node; `044` dropped `projects.path`, which now lives on sources only, with one project per checkout). That ID is data only: **no server code singles out a node** (`node-dependency-boundary.test.ts` checks it). Sessions persist `source_id` alongside `project_id`, with SQLite triggers enforcing project/source agreement; a new session is placed on its caller's source or the project's default source (its first). The node opens a session in its bound source path rather than the project's current path. Browser prompt/steer enter through `Sessions.submit` (`models/sessions.ts`), as does every other submission (model changes, code-review prompts, scripting sends, child reports); browser abort and explicit resume are `Sessions.abort`/`resume`, direct calls to the session's node. `submit` persists the command and wakes the hub itself (`state.nodes.wake()`, no caller wakes); only the outbox store (`nodes/node-command-store.ts`, plus startup recovery in `nodes/node-command-recovery.ts`) reads or writes the outbox table; its dispatcher settles each delivery (`deliverCommand`). The hub's dispatcher (`nodes/node-command-dispatcher.ts`) routes each session once per delivery (`sessionRoute`) and delivers to the link of its source's node while it is connected; other work waits. Nodes connect by dialing (the local node over the handler load's Unix socket listener), announce their node ID in `node.hello`, and are served only if that node row exists. `packages/node/src/node.ts` owns Pi assembly over the server's storage, the live runtime cache and command execution; it holds nothing durable. `nodes/node-handlers.ts` serves each node's calls (storage reads and commits, lifecycle reports, attachments, credentials, tool calls) over its link. Moving a session re-points its source (`sessions/session-ownership.ts`; see node-contract.md *Moving a session*). Scripting-directed sends, waits and model changes go through the outbox and server projections. See node-contract.md *Node hub*.

### Pi integration (`src/pi/`)

The server uses Pi only as a library for its model catalog and credentials; it builds no session runtime and runs no inference (task generation runs on a node as a background session, above).

Key entry points:

- `pi/registry.ts` — runtime-neutral model catalog shapes (no adapter registry: callers use Pi's catalog directly)
- `pi/factory.ts` — the server's own Pi model runtime over product SQLite credentials, built directly from Pi (not the node package), including bounded remote model-catalog refresh; also the model runtime behind `credentials.refresh` (`nodes/node-credentials.ts`)
- `pi/credential-store.ts` — adapts Pi's credential-store contract to Reins SQLite API-key/OAuth records
- `pi/model-catalog.ts` — provider listing/auth-source metadata built on top of Pi's model runtime (`buildProviderList`, `listRuntimeProviders` for `GET /api/models` and `models.list`), and single-model lookup (`findPiModel`, used to validate model changes)
- `pi/pending-operation.ts` — reads a session's durable pending operation from its storage for session views
- `pi-storage.ts` (`PiStorageAdapter`, in `src/`) — AgentHarness SQLite storage, the only copy of every session: the server serves the node's `storage.read`/`storage.commit` from it (`SessionModel` in `models/session.ts`) and reads transcripts (`messages-store.ts`, `models/session-context.ts`); `pi-session-store.ts` holds only the admission proof the outbox deduplicates input against (`storedInput`); nothing else writes server Pi tables

## Dependency rules

- Stores don't import git, models, routes, or tools.
- Models don't import routes, tools, ws or nodes/ (the outbox store, `nodes/node-command-store.ts`, excepted: the outbox is queued and read through it).
- Routes, tools, and ws don't import each other.
- All layers can import stores and utilities, except `nodes/`: it imports stores, `db.ts` and `pi-storage.ts` only with `import type`, apart from its own outbox store (Oxlint `reins/nodes-through-models`). What it needs from the database is a model method.

## Current state

The models layer covers all route handlers and some backend domain helpers:

- `models/tasks.ts` — task create/update/delete with branch orchestration, list with diff stats
- `models/workspace.ts` — checkout-scoped file and diff behavior. `Workspace` selects the `WorkingTreeFileSystem` or `GitTreeFileSystem` adapter for file reads and owns changed-file summaries and raw patch streams, run through the source's `Git` (untracked files diff through a temporary index the `Git` builds beside the checkout). The filesystem interface, shared path policy, and adapters live in their own `models/*-file-system.ts` modules. `WorkingTreeFileSystem` reads through `fs.read`. File routes must obtain content through this model rather than accessing the checkout directly.
- `models/projects.ts` — project creation (with its first source) and the project's own data: tasks, code reviews, and `workspace` (the call's source against the project's base branch)
- `models/sources.ts` — a project's checkouts on nodes: creating, moving and resolving sources (`resolveSource`; a session's: `sessionSource`, `requireSessionSource`), and what reads or changes one checkout on its node: its `Git`, file listing (`fs.list`), `workspace(baseBranch)` (`fs.read`, diffs), `sync` (fetch and fast-forward), skills and uploads (`fs.write`)
- `models/sessions.ts` — the `Sessions` model: everything a session does with its node, plus its metadata, lists and transcript reads. `get(sessionId)` is one session as its node works with it (`SessionModel`, or `SessionNotFoundError`), as `Nodes.get` is for a node; `getDetail(sessionId)` is its detail view for the API (null when it does not exist).
  - **Work for the node:** `submit(sessionId, command)` is the one way to submit session work: it queues typed prompt/steer/setModel commands in the outbox (validating the session's source; callable inside a caller's transaction, it wakes delivery in a microtask, after that transaction commits). `setModel` queues its model change this way.
  - **Direct calls:** `abort` and `resume` are not submitted: they call the session's node directly (`RemoteNode.request`, each with its own timeout; never queued, `SessionCallFailed` with a `NodeError` on a refusal or an unreachable node).
  - **Moving:** `moveTargets` and `move` re-point the session at another node's source (`sessions/session-ownership.ts`).
  - **Metadata and reads:** custom display names and explicit independent pin/archive timestamps, cursor-paginated display message reads, attachment upload/fetch, and related broadcast behavior. Normal session lists exclude archived and background rows and order pinned rows first while preserving activity recency within each group. Opening a session and runtime activity do not alter archive state. Initial display reads return the latest backward-paginated window; opaque `before` cursors load history and opaque `after` cursors synchronize every forward page from the persisted tail. Display page items expose stable `id` and nullable `parentId` links; the current linear transcript points each item to the immediately preceding persisted message, including parents outside the returned window. Soft page boundaries keep assistant tool calls with their persisted results in both directions.
- `models/session.ts` — one session as its node works with it: `SessionModel` (its row: `source()`, `binding(source)` and `context(source)`, the `SessionContext` every call that may open its runtime carries (binding, lane seed, and the kind's runtime and branch), `attachment`/`storeAttachment`, and `readStorage`/`commitStorage` on its Pi storage)
- `models/nodes.ts` — the server's nodes: `Nodes` (built from the hub and a broadcast: `list()`, `get(nodeId)` → `NodeModel` or `NodeNotFoundError`, `publish(nodeId)`, the one way browsers hear of a node, and `pairing()`)
- `models/node.ts` — one node: `NodeModel` (its row: `view()` → `NodeView`, `reload()` (`node.reload`, for `POST /api/nodes/:nodeId/reload` and `api.nodes.reload`), `revoke()`, `remove()`; for its link, `publicKey` (the key a challenge checks, kept when revoked) and `assertMayConnect()`, the one check of revocation, at every hello) and the errors it throws (`NodeNotPairedError`, `NodeInUseError`, `NodeRevokedError`, `NodeRefusedError`)
- `models/node-pairing.ts` — `NodePairing` (`Nodes.pairing()`): pairing codes (`createCode`) and their redemption (`redeem`) for a new node's key
- `models/session-activity.ts` — whether a session is busy, from server projections only (`sessionActivity`: running, queued input in the outbox, or idle; `activeSessionIds`); used by session views, task deletion, session moves and `/api/health`
- `models/uploaded-file.ts` — wraps browser `File` uploads at the HTTP/model boundary and extracts validated attachment bytes/metadata
- `models/model-settings.ts` — thinking-level schema/parsing plus resolution of stored model settings against a Pi model runtime
- `models/broadcast.ts` — typed broadcast abstraction over WS clients
