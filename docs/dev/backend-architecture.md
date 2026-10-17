# Backend Architecture

The backend is layered with a one-way dependency direction:

```
routes / tools / ws / nodes
            ↓
          models
            ↓
    stores + utilities
```

`src/nodes/` (the node link) is an adapter like the routes: it serves the node's calls through models, not stores.

## Layers

### Routes (`src/routes/`)

Thin HTTP adapters. Parse requests, call model functions, format responses. Every HTTP endpoint is a route, outside `/api` too: the WebSocket upgrades, the browser's `/ws` (`routes/sockets.ts`), and what a remote node's machine reaches under `/nodes`: the node link `/nodes/link` and the install script, manifest and bundle (`routes/nodes.ts`, beside `/api/nodes`). Error handling is via thrown `HttpError`s (see [router.md](router.md)). A route reaches models through `ctx.models` (the request's `Models`, below), never by constructing them.

Shared built-in HTTP DTOs live beside the route, model, or store that sends the data. The frontend and `@reins/client` may import these only as types (the client by package name, `@reins/backend/*`, which the package's `exports` maps to `src/`). Runtime endpoint construction and transport behavior belong entirely to `@reins/client` (`packages/client`), the one client of the HTTP API for the browser app, scripts and tests ([ADR-022](../adr/022-shared-api-client-package.md)); when a tool needs an endpoint, add it to the client beside the route. The backend does not publish endpoint descriptors or a plugin-facing client contract. An `/api` path no route matches is a JSON 404, and a `/nodes` path a plain one (`handler.ts`; see [router.md](router.md) *Unknown routes*).

### Tools (`src/tools/`)

Agent tool definitions are a session runtime's (`session-runtime/reins-tools.ts`). The server implements what they call: `tools/index.ts` (`serverToolCalls`, `ReinsToolCalls`) runs a script, an API search or a task creation for the calling session, which a session's runtime delivers to the current app (`App.executeScript`, `searchScript`, `createTask`; session-runtime.md *Reaching the current app*). Scope comes from the server's session row at call time, never from the caller.

**Current tools:**

- **`create_task`** — creates a task with a git branch. Available in all sessions. Optional `prompt` parameter kicks off a fire-and-forget session on the new task.
- **`search`** — discovers the curated `execute` API surface by returning documentation-only TypeScript interfaces from `src/scripting/api-registry.ts`.
- **`execute`** — runs an async JavaScript function body in a VM with only the curated `api` object in scope. Scripting functions live under `src/scripting/`; session-analysis helpers should extend `api.sessions` rather than introducing a separate analytics namespace. Keep `src/scripting/*` as execute/search glue: TypeBox schemas, descriptions/tags, project/task access checks, and delegation to stores/models. DB-backed filtering/extraction logic (for example session entry/message/tool-call extraction) belongs in `src/*-store.ts` so scripting is not the source of truth.

Session orchestration is exposed as `api.sessions.start/send/wait` through search/execute, not specialized delegation tools. `createSession(state, projectId, opts)` in `sessions/create-session.ts` creates sessions (the row, on its source, with its model frozen from the options or `default_model`; Pi's lane is created when its runtime first opens, `session-runtime/`). `new SessionInstance(state, callerSessionId)` (`sessions/session-instance.ts`) is the caller-scoped scripting API; it owns scope and child-depth policy, addressed prompt or steering submission (resolving once admitted) and bounded waits. A session's run (lifecycle reports and their effects: activity, metadata, a child's report to its parent; recovery at process start; waits) is `sessions/session-runs.ts`; whether a session is busy (`sessionActivity`, `activeSessionIds`) is read in `models/session-activity.ts`. Addressed sends always enter through native steering so AgentHarness joins active work or starts/resumes idle work; there is no Reins-managed follow-up queue. The tool abort signal is passed only to bounded observation; cancelling a wait never invokes the target runtime's abort. See [session-runtime.md](session-runtime.md#session-orchestration).

A **background session** (`sessions.background = 1`, `createSession(..., { background: true })`) is a real session — a runtime on the server, tools on its source's node, settlement, stored transcript, waits, child reports — that the browser never shows. Reins features (extensions, server features) start them; scripts cannot (`sessions.start` has no such option), though `sessions.list` can include them (`background: "only" | "include"`) and session results expose `background`. Server reads that feed the browser leave them out: `listSessions` (by default), `listPaletteItems`, `listSessionsWithActivity` (the activity snapshot) and `listTasks`' `session_count`/`session_ids`. Creating one is not announced (no `session_created`: the browser would list it before learning what it is); later broadcasts about them (`session_updated`, live events) are sent as for any session; the session detail view carries `background: true`, and the browser's `SessionCache` leaves such sessions out of `entries()`, which its lists and activity badges iterate (see frontend-architecture.md). Creating one does not touch its task's `updated_at`.

A session's **kind** (`sessions.kind`, `createSession(..., { kind })`, default `"agent"`) defines how it runs: its system prompt, its tools, whether its environment is appended and the branch checked out. The registry is `sessions/session-kinds.ts` (name → resolver of that configuration from the session and task rows, read at every runtime open; `registerSessionKind`); the agent kind's prompt is `sessions/system-prompt.ts`. Kinds are validated in code (no DB constraint) and are not exposed to scripting. See session-runtime.md *Session kinds*.

### WebSocket handlers (`src/ws.ts`)

Command dispatch for `prompt`, `steer`, `abort`. Prompt and steer messages are validated at the WS boundary and use block-only content (`[{ type: "text", text }]` plus optional image refs), then submitted to the session's runtime (`Sessions.submit`): the sender gets its ack once Pi committed the input, or the submission's error (`{type: "error", sessionId, clientId, error: "prompt failed: …"}`). WS does not expand skills or hydrate attachments; the session's runtime does. Abort acts on the session's live runtime (`Sessions.abort`).

### Models (`src/models/`)

Business logic: orchestrates stores, git operations, validation, and WS broadcasts. Model functions throw on failure — callers decide how to surface errors (HTTP status, tool error result, etc.).

WS broadcasts for state changes live here so every caller gets them automatically.

Entry points get their models from one `Models` (`models/models.ts`), built from the app's state (`AppState`): the router builds one per request (`ctx.models`), ws.ts one per message, a session's Reins tool calls one per call (`App.executeScript`, …: scripts' `ApiContext.models`, `create_task`'s scope) and the hub one for its lifetime. It holds nothing but the models it built (`broadcast`, through the process's browser connections; `credentials`, the server's credential store under the process's lock, for the model catalog and OAuth logins; `nodes`, `sessions`, each built on first use and reused within it; `project(projectId, sourceId?)` a `ProjectModel` in that source, by default the project's default source), so it is cheap to build. Code below the entry points (`sessions/`, models) takes the models or broadcast it needs from its caller.

### Stores (`src/*-store.ts`)

Thin SQLite access. CRUD operations and queries, including DB-backed read projections used by scripting APIs. No git, no broadcasts, no business logic beyond what the DB enforces.

### Migrations (`src/migrations.ts`)

The server process opens the database once (`openDatabase` in `src/database.ts`: the file and its pragmas; `ServerProcess.db`) and passes it to every app ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md)). Each app, when it starts (`start` in `server.ts`), makes it the connection the stores reach through `getDb()` (`setDb`: the `getDb()` global stays the stores' way to the database) and runs migrations on it (`prepareDatabase` in `src/db.ts`): at process startup and, in dev, on every reload, once the previous app has stopped. Only pending migrations apply, so a new migration takes effect on the next reload. No app closes the connection. Standalone tools that never `setDb` open and prepare their own (`getDb`).

Schema-only migrations can be SQL strings. Data migrations that need application logic (for example JSON tree rewrites, hashing, or BLOB creation) should live under `src/migrations/` and be imported into the same ordered migration list.

### Utilities

- `src/git.ts` — `Git`, one checkout's git operations (branch, checkout, refs, blobs, diff streams), run through an injected `Spawn` (`src/spawn.ts`): `nodeSpawn` on a source's node (tests: `localGit`). Raw command runners stay private; add semantic methods instead of exposing them.
- `src/branch-name.ts` — branch-name slugification (`slugifyBranchName`: `task/<slug>`)

Stateless helpers that don't depend on other layers.

### Sessions, nodes and the node link

**Sessions run on the server** ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md), [session-runtime.md](session-runtime.md)): a session's runtime (`session-runtime/`, below) runs in the server process, kept across reloads, and its tools run on the node of its source (`sessions.source_id`; see node-contract.md *Node hub*, *Tool host*). What the process owns is its `ServerProcess` (`state.ts`: the database, browser broadcast, open sessions, credential locks, the current app and the run reports waiting for one, frontend dir, node socket), passed whole to every app; each app builds its `AppState` (`createAppState` in `state.ts`: `process` plus this app's node hub, `/nodes/link` endpoint and node bundle), which routes, ws handlers and models take. A session runtime keeps the `ServerProcess`, never the `AppState` (hot-reload.md *Ownership*).

`src/nodes/` — everything about nodes on the server: the link to them. It reloads with the rest of the app. It is an adapter above models (see *Dependency rules*): the hub builds one `Models` from its state once it is in use.

The link:

- `nodes/node-hub.ts` — the node links, with the state it belongs to and its models; a challenge's key is `NodeModel.publicKey`, and a hello is refused for a node `NodeModel.assertMayConnect` refuses (unknown, removed, revoked)
- `nodes/server-peer.ts` — the server half of one node connection (hello and negotiation, wire methods); `nodes/node-streams.ts` — its stream registry; `nodes/local-socket.ts` — the local node's Unix socket listener

A node calls nothing on the server but the frames of the streams the server opened (`stream.data`, `stream.end`).

`src/session-runtime/` — a session's runtime on the server ([session-runtime.md](session-runtime.md)), where all submitted work goes (`Sessions.submit`, session-runtime.md *Submission and ordering*).

- `session-runtime/live.ts` — all on the `ServerProcess` (an app passes `state.process`): `withSessionRuntime` (a use retried once on a faulted runtime), `closeSessionRuntime(s)` (deletion, moves, node removal), and `openSessionRuntime(process, sessionId, {model?})`: the session's live runtime from the process's map (`OpenSessions.live`), opened from its rows (`SessionModel.context`: binding, branch, lane seed, the kind's runtime configuration) when it has none, one opening per session at a time; reopened when its binding changed, a newer app retired it (once idle) or a storage failure faulted it
- `session-runtime/build.ts` — assembly: `PiStorageAdapter` on the process's connection (inline images stored as attachments before each commit, `storage.ts`), the server's model runtime (`pi/factory.ts`) over the server's credentials (under the process's locks), Pi's tools over `RemoteExecutionEnv` on the session's node (`tools.ts`, with bash's environment per call and `read` of the server's own `~/.agents` served here, a stopgap), the Reins tools delivered to the current app (`reins-tools.ts`), events through the process's broadcast (`sessionEventFrame`, `events.ts`), run lifecycle applied by the runtime itself, in order (`runStarted`/`runSettled` of `sessions/session-runs.ts` on the process's database and broadcast, no app involved), attachments on the process's database, and the run's system prompt prepared at its first assistant request
- `session-runtime/pi-runtime.ts` — `AgentHarnessPiRuntime` (`SessionRuntime`): admission, steering, abort, model changes, pause points, event shaping; a run's system prompt prepared once per run (`PrepareRun`), waiting for the node as a pause point, abortable, and a failure fails the run
- `session-runtime/environment.ts` — the checkout prepared on the node (task branch through the server's `Git` over `process.run`), the environment section of the system prompt, slash expansion; `resources.ts` — the server's `~/.agents` (AGENTS.md, user skills) merged with the checkout's, both discovered by the server (Pi's `loadSkills`; the checkout's through its node, `fs.*`)
- `session-runtime/attachments.ts`, `tool-images.ts` — a runtime's attachment cache in front of the store, prompt references checked before admission, tool-result images stored as attachments
- `app.ts` — `createApp(state)`: an app's `App`, what the process's runtimes call on the current app (`node()`, the Reins tools; `code`, its bundle's `APP_CODE`), registered with the process from the app's start to its stop
- `process-state.ts` (process-owned) — `createServerProcess`: the `ServerProcess` around the resources `server-process.ts` gives it, with its `OpenSessions` (`createOpenSessions`: the runtime map, each session's submission chain, the pause gate and the idle sweep), credential locks, and the current app (`app`, a plain property, and `registerApp`); `suspendSessions`, the process's SIGTERM path

`src/sessions/` — a session's lifecycle on the server.

- `sessions/create-session.ts` — session creation (placed on the caller's source or the project's default source; of a registered kind)
- `sessions/session-kinds.ts` — the session kind registry: how each kind's sessions run (system prompt, tools, environment, branch); built in: `agent` and the `task-generator` utility kind
- `sessions/task-generator.ts` — task generation from freeform input (`generateTask`, `POST /api/projects/:id/tasks/generate`): a background `task-generator` session on the request's source with the utility model, needing no node, waited on (30 s) for the input it submitted, parsed, then its runtime closed and the session deleted
- `sessions/system-prompt.ts` — the Reins system prompt of agent sessions (task or project-assistant section, orchestration)
- `sessions/session-instance.ts` — `api.sessions.start/send/wait` for one calling session: scope, child depth, submission and waits
- `sessions/session-runs.ts` — a session's run as the server records it (`runStarted(process, …)` and `runSettled(process, …)`, which a runtime applies itself (a child's report steered to its parent first, through `submitToSession`, then the settlement committed); `sessionRuns(state)`: `recoverInterruptedRuns` (at process start, within `takeAutoResume`'s budget), `interruptRunsOn`, `waitForSettlement`; `latestSettlement`, `runInProgress`), on the session row and its storage
- `sessions/session-ownership.ts` — the node a session runs on, moving a session between nodes, and the IDs of the sessions a deletion removes (`sessionIdsIn`)

### Nodes and sources

`nodes` identifies execution hosts; `sources` binds a project to a host-local path. Migration `029` seeds one node row (`internal`, the ID the local node process announces by default) and gave every existing project a source on it. A new project's first source is created with it on the node its creator chose (`createProject`), and each source's path is edited on the source (migration `043` dropped the triggers that used to do both on the seeded node; `044` dropped `projects.path`, which now lives on sources only, with one project per checkout). That ID is data only: **no server code singles out a node** (`node-dependency-boundary.test.ts` checks it). Sessions persist `source_id` alongside `project_id`, with SQLite triggers enforcing project/source agreement; a new session is placed on its caller's source or the project's default source (its first). A session's tools run in its bound source path rather than the project's current path. Browser prompt/steer enter through `Sessions.submit` (`models/sessions.ts`), as does every other submission (code-review prompts, scripting sends, child reports, task generation), and model changes through `Sessions.setModel`, in order with them; browser abort and explicit resume are `Sessions.abort`/`resume`, on the session's live runtime. Nodes connect by dialing (the local node over the app's Unix socket listener), announce their node ID in `node.hello`, and are served only if that node row exists. A node is a tool and file host (node-contract.md *Tool host*); it holds nothing durable. Moving a session re-points its source (`sessions/session-ownership.ts`; see node-contract.md *Moving a session*). See node-contract.md *Node hub*.

### Pi integration (`src/pi/`)

The server uses Pi as a library: its model catalog and credentials, and the model runtime its sessions run on (`session-runtime/`).

Key entry points:

- `pi/registry.ts` — runtime-neutral model catalog shapes (no adapter registry: callers use Pi's catalog directly)
- `pi/factory.ts` — the server's own Pi model runtime over the credential store it is given (the server's: `Models.credentials`, a runtime's own), built directly from Pi (not the node package), including bounded remote model-catalog refresh; also that of sessions running on the server (`session-runtime/`)
- `pi/credential-store.ts` — adapts Pi's credential-store contract to Reins SQLite API-key/OAuth records (`DbCredentialStore`), each provider's modifications under the process's locks (`ServerProcess.credentialLocks`), so every store shares them whichever app built it
- `pi/model-catalog.ts` — provider listing/auth-source metadata built on top of Pi's model runtime (`buildProviderList`, `listRuntimeProviders` for `GET /api/models` and `models.list`), and single-model lookup (`findPiModel`, used to validate model changes)
- `pi/run-state.ts` — Reins' reads of Pi's run state from a session's storage, through Pi's exported address helpers and types: the operation in progress on its main lane (session views' `pendingOperation`)
- `pi-storage.ts` (`PiStorageAdapter`, in `src/`) — AgentHarness SQLite storage, the only copy of every session: sessions' runtimes run on it (`session-runtime/storage.ts`) and the server reads transcripts (`messages-store.ts`, `models/session-context.ts`); `pi-session-store.ts` holds only the admission proof waits read (`storedInput`); nothing else writes server Pi tables

## Dependency rules

- Stores don't import git, models, routes, or tools.
- Models don't import routes, tools, ws or nodes/.
- Routes, tools, and ws don't import each other.
- All layers can import stores and utilities, except `nodes/`: it imports stores, `db.ts` and `pi-storage.ts` only with `import type` (Oxlint `reins/nodes-through-models`). What it needs from the database is a model method.
- Process-owned sources (`src/process-owned.json`) import at runtime only each other, `@reins/node-protocol` and packages (Oxlint `reins/process-owned-imports`): they reach product code only through the registered app (`ServerProcess.app`).

## Current state

The models layer covers all route handlers and some backend domain helpers:

- `models/models.ts` — `Models`, the models of one request, message or call (above): `broadcast`, `nodes`, `sessions`, `project(projectId, sourceId?)`
- `models/tasks.ts` — task create/update/delete with branch orchestration, list with diff stats
- `models/workspace.ts` — checkout-scoped file and diff behavior. `Workspace` selects the `WorkingTreeFileSystem` or `GitTreeFileSystem` adapter for file reads and owns changed-file summaries and raw patch streams, run through the source's `Git` (untracked files diff through a temporary index the `Git` builds beside the checkout). The filesystem interface, shared path policy, and adapters live in their own `models/*-file-system.ts` modules. `WorkingTreeFileSystem` reads through `fs.read`. File routes must obtain content through this model rather than accessing the checkout directly.
- `models/projects.ts` — project creation (with its first source) and the project's own data: tasks, code reviews, and `workspace` (the call's source against the project's base branch)
- `models/sources.ts` — a project's sources (its working copies on nodes): creating, moving and resolving sources (`resolveSource`; a session's: `sessionSource`), and what reads or changes one checkout on its node: its `Git`, file listing (`fs.list`), `workspace(baseBranch)` (`fs.read`, diffs), `sync` (fetch and fast-forward), skills and uploads (`fs.write`)
- `models/sessions.ts` — the `Sessions` model (built from the app's state, its hub and its process's sessions, and a broadcast): everything a session does, plus its metadata, lists and transcript reads. `get(sessionId)` is one session as its runtime opens it (`SessionModel`, or `SessionNotFoundError`), as `Nodes.get` is for a node; `getDetail(sessionId)` is its detail view for the API (null when it does not exist).
  - **Work for the session:** `submit(sessionId, {op, content, clientId, sourceSessionId?})` is the one way to submit session work: it admits prompt/steer input in the session's runtime (refusing an unknown session, content too large and a session whose node was removed first) and resolves once Pi committed it; `setModel` applies a model change through the runtime, then updates the row. Both enter the session's chain when called, so a session's submissions apply in arrival order (session-runtime.md *Submission and ordering*).
  - **Abort and resume:** act on the session's live runtime (`abort` opens none: `{aborted: false}` without one; `resume` may open it).
  - **Moving:** `moveTargets` and `move` re-point the session at another node's source (`sessions/session-ownership.ts`) and close its live runtime.
  - **Metadata and reads:** custom display names and explicit independent pin/archive timestamps, cursor-paginated display message reads, attachment upload/fetch, and related broadcast behavior. Normal session lists exclude archived and background rows and order pinned rows first while preserving activity recency within each group. Opening a session and runtime activity do not alter archive state. Initial display reads return the latest backward-paginated window; opaque `before` cursors load history and opaque `after` cursors synchronize every forward page from the persisted tail. Display page items expose stable `id` and nullable `parentId` links; the current linear transcript points each item to the immediately preceding persisted message, including parents outside the returned window. Soft page boundaries keep assistant tool calls with their persisted results in both directions.
- `models/session.ts` — one session as its runtime opens it: `SessionModel` (its row: `source()`, `assertRunnable(source)` (`SessionNodeRemovedError` when its node was removed), `binding(source)` and `context(source)`, the `SessionContext` its runtime is opened with: binding, lane seed, and the kind's runtime configuration and branch)
- `models/nodes.ts` — the server's nodes: `Nodes` (built from the state and a broadcast: `list()`, `get(nodeId)` → `NodeModel` or `NodeNotFoundError`, `publish(nodeId)`, the one way browsers hear of a node, and `pairing()`)
- `models/node.ts` — one node: `NodeModel` (its row: `view()` → `NodeView`, `reload()` (`node.reload`, for `POST /api/nodes/:nodeId/reload` and `api.nodes.reload`), `rename(name)` (`PATCH /api/nodes/:nodeId`: trimmed, 1 to `MAX_NODE_NAME_LENGTH` characters, else `InvalidNodeNameError`), `revoke()`, `remove()` (abandons the node: `removed_at`, its sessions stay; node-contract.md *Pairing and authentication*, Removal); for its link, `publicKey` (the key a challenge checks, kept when revoked or removed) and `assertMayConnect()`, the one check of removal and revocation, at every hello) and the errors it throws (`InvalidNodeNameError`, `NodeNotPairedError`, `NodeRemovedError`, `NodeRevokedError`, `NodeRefusedError`)
- `models/node-pairing.ts` — `NodePairing` (`Nodes.pairing()`): pairing codes (`createCode`) and their redemption (`redeem`) for a new node's key
- `models/session-activity.ts` — whether a session is busy (`sessionActivity(row, sessions)`: running from its row, or its runtime admitting or driving input; `activeSessionIds`); used by session views, task deletion, session moves and `/api/health`
- `models/uploaded-file.ts` — wraps browser `File` uploads at the HTTP/model boundary and extracts validated attachment bytes/metadata
- `models/model-settings.ts` — thinking-level schema/parsing plus resolution of stored model settings against a Pi model runtime
- `models/broadcast.ts` — typed broadcast abstraction over the process's browser connections (`ServerProcess.broadcast`)
