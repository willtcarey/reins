# Backend Architecture

The backend is layered with a one-way dependency direction:

```
routes / tools / ws
       ↓
     models
       ↓
  stores + utilities
```

## Layers

### Routes (`src/routes/`)

Thin HTTP adapters. Parse requests, call model functions, format responses. Error handling is via thrown `HttpError`s (see [router.md](router.md)).

Shared built-in HTTP DTOs live beside the route, model, or store that sends the data. The frontend may import these only as types. Runtime endpoint construction and transport behavior belong entirely to the internal frontend client; the backend does not publish endpoint descriptors or a plugin-facing client contract.

### Tools (`src/tools/`)

Agent tool definitions live on the node (`@reins/node/reins-tools`, assembled by the node's runtime builder). The server implements what they call: `tools/index.ts` (`serverToolCalls`) runs `script.execute`, `script.search` and `project.createTask` for the calling session, reached over the node link (`nodes/node-tool-calls.ts`; see node-contract.md *Agent tools*). Scope comes from the server's session row at call time, never from the caller.

**Current tools:**

- **`create_task`** — creates a task with a git branch. Available in all sessions. Optional `prompt` parameter kicks off a fire-and-forget session on the new task.
- **`search`** — discovers the curated `execute` API surface by returning documentation-only TypeScript interfaces from `src/scripting/api-registry.ts`.
- **`execute`** — runs an async JavaScript function body in a VM with only the curated `api` object in scope. Scripting functions live under `src/scripting/`; session-analysis helpers should extend `api.sessions` rather than introducing a separate analytics namespace. Keep `src/scripting/*` as execute/search glue: TypeBox schemas, descriptions/tags, project/task access checks, and delegation to stores/models. DB-backed filtering/extraction logic (for example session entry/message/tool-call extraction) belongs in `src/*-store.ts` so scripting is not the source of truth.

Session orchestration is exposed as `api.sessions.start/send/wait` through search/execute, not specialized delegation tools. `createSession(state, projectId, opts)` in `sessions/create-session.ts` creates sessions (the row, on its source's node, with its model frozen from the options or `default_model`; the node creates Pi's lane when it first opens the session); the server opens no runtime. Runtime assembly/cache is on the node (`packages/node/src/node.ts`, `packages/node/src/runtime/build.ts`). `new SessionInstance(state, callerSessionId)` (`sessions/session-instance.ts`) is the caller-scoped scripting API; it owns scope and child-depth policy, addressed prompt or steering submission to the outbox and bounded waits. A session's run (node lifecycle reports and their effects: activity, metadata, a child's report to its parent; crash recovery; activity reads; waits over server projections) is `sessions/session-runs.ts`. Addressed sends always enter through native steering on the node so AgentHarness joins active work or starts/resumes idle work; there is no Reins-managed follow-up queue. The tool abort signal is passed only to bounded observation; cancelling a wait never invokes the target runtime's abort. See [node-runtime.md](node-runtime.md#session-orchestration).

### WebSocket handlers (`src/ws.ts`)

Command dispatch for `prompt`, `steer`, `abort`. Prompt and steer messages are validated at the WS boundary and use block-only content (`[{ type: "text", text }]` plus optional image refs), then persisted to the node command outbox. WS does not expand skills or hydrate attachments; the node expands slash skills with the bound source cwd and hydrates attachments at the provider boundary. Abort is forwarded to the session's node; a session at rest on the server answers "Session not active".

### Models (`src/models/`)

Business logic: orchestrates stores, git operations, validation, and WS broadcasts. Model functions throw on failure — callers decide how to surface errors (HTTP status, tool error result, etc.).

WS broadcasts for state changes live here so every caller gets them automatically.

### Stores (`src/*-store.ts`)

Thin SQLite access. CRUD operations and queries, including DB-backed read projections used by scripting APIs. No git, no broadcasts, no business logic beyond what the DB enforces.

### Migrations (`src/migrations.ts`)

Migrations and outbox recovery run once per process, when `server-process.ts` opens the database (`openDb` in `src/db.ts`); it injects that handle into every handler bundle it loads, so a dev hot reload reuses the connection and a new migration needs a server restart.

Schema-only migrations can be SQL strings. Data migrations that need application logic (for example JSON tree rewrites, hashing, or BLOB creation) should live under `src/migrations/` and be imported into the same ordered migration list.

### Utilities

- `src/git.ts` — `Git`, one checkout's git operations (branch, checkout, refs, blobs, diff streams), run through an injected `Spawn` (`src/spawn.ts`): `RemoteNode.spawn` on a source's node (tests: `localGit`). Raw command runners stay private; add semantic methods instead of exposing them.
- `src/task-generator.ts` — LLM-powered task generation from freeform input, and branch-name slugification (`slugifyBranchName`)

Stateless helpers that don't depend on other layers.

### Sessions, nodes and the node link

**The server never executes sessions.** Every session runs on the node of its source (`sessions.source_id`; see node-contract.md *Node hub*). The server holds no live runtimes: `ServerState` is process-owned state (WS clients, frontend dir and `state.nodes`), preserved across handler reloads.

`src/node-link/` — process-owned (never hot reloads; see hot-reload.md): the connection to nodes and the command outbox.

- `node-link/node-hub.ts` — the node links, dispatcher and submission failure recipients; defines its port into product code (`NodeHubServices`: `handlers`, `recover`, `route`, `delivered`)
- `node-link/server-peer.ts` — the server half of one node connection (hello, epochs, wire methods); `node-link/local-socket.ts` — the local node's Unix socket listener
- `node-link/node-command-dispatcher.ts` — outbox delivery chains and settlement (`deliverCommand`)
- `node-link/node-command-store.ts` — the outbox table (the only code that reads or writes it); `node-link/node-command-recovery.ts` — startup recovery

`src/nodes/` — reloadable product code the hub reaches through its port.

- `nodes/node-services.ts` — the port's adapter (`nodeServerServices`), captured per call on existing links; builds each node's node→server handlers (storage, lifecycle reports, attachments, credentials, tool calls), fenced by the session's source being on that node
- `nodes/commands.ts` — `sessionRoute`: a session's node, wire dispatch and outcome classification; preserves typed wire results rather than inventing a second result vocabulary
- `nodes/node-storage.ts` — the server half of the node's `RemoteStorage`: `readStorage`/`commitStorage` on the session's Pi storage
- `nodes/node-credentials.ts` — credential reads and OAuth refresh for nodes
- `nodes/node-tool-calls.ts` — the server side of the node's Reins tools
- `nodes/node-session-events.ts` — a node's session reports: relays live events to browsers, hands `session.started`/`session.settled` to `sessions/session-runs.ts`
- `nodes/node-command-notifications.ts` — settled-command failure notifications

`src/sessions/` — a session's lifecycle on the server.

- `sessions/create-session.ts` — session creation (placed on the caller's source or the project's default source)
- `sessions/node-source.ts` — `resolveSessionSource`, what commands carry (`commandTarget`) and the default source policy
- `sessions/node-execution.ts` — the one way to submit session work: `submit(nodes, sessionId, command)` queues typed prompt/steer/setModel commands in the outbox (validating the session's source; callable inside a caller's transaction, it wakes delivery in a microtask, after that transaction commits) and `control(nodes, sessionId, "abort" | "resumePending")` sends an immediate control
- `sessions/session-instance.ts` — `api.sessions.start/send/wait` for one calling session: scope, child depth, submission and waits
- `sessions/session-runs.ts` — a session's run as the server sees it (`sessionRuns({ broadcast, nodes })`: `runStarted`, `runSettled`, `settleInterruptedRuns`, `waitForSettlement`; `sessionActivity`, `activeSessionIds`, `latestSettlement`, `runInProgress`), all on the session row, the outbox and its storage
- `sessions/session-ownership.ts` — whether a node owns a session, and moving a session between nodes

### Nodes and sources

`nodes` identifies execution hosts; `sources` binds a project to a host-local path. Migration `029` seeds one node row (`internal`, the ID the local node process announces by default) and gives every project a source on it (existing projects on migration, new ones by trigger; path updates follow that original source). That ID is data only: **no server code singles out a node** (`node-dependency-boundary.test.ts` checks it). Sessions persist `source_id` alongside `project_id`, with SQLite triggers enforcing project/source agreement; a new session is placed on its caller's source or the project's default source (its first). The node opens a session in its bound source path rather than the project's current path. Browser prompt/steer/abort and explicit resume enter `sessions/node-execution.ts`, as does every other submission (model changes, code-review prompts, scripting sends, child reports). `submit` persists the command and wakes the hub itself (`state.nodes.wake()`, no caller wakes); only the outbox store (`node-link/node-command-store.ts`, plus startup recovery in `node-link/node-command-recovery.ts`) reads or writes the outbox table; its dispatcher settles each delivery (`deliverCommand`). The hub's dispatcher (`node-link/node-command-dispatcher.ts`) routes each session once per delivery (`sessionRoute`) and delivers to the link of its source's node while it is connected; other work waits. Nodes connect by dialing (the local node over the process owner's Unix socket), announce their node ID in `node.hello`, and are served only if that node row exists. `packages/node/src/node.ts` owns Pi assembly over the server's storage, the live runtime cache and command execution; it holds nothing durable. `nodes/node-services.ts` serves each node's calls (storage reads and commits, lifecycle reports, attachments, credentials, tool calls) over its link. Moving a session re-points its source (`sessions/session-ownership.ts`; see node-contract.md *Moving a session*). Scripting-directed sends, waits and model changes go through the outbox and server projections. See node-contract.md *Node hub*.

### Pi integration (`src/pi/`)

The server uses Pi only as a library; no session runtime is built on the server.

Key entry points:

- `pi/registry.ts` — runtime-neutral model catalog and utility-ask shapes (no adapter registry: callers use Pi's catalog and asks directly)
- `pi/factory.ts` — the server's own Pi model runtime over product SQLite credentials, built directly from Pi (not the node package), including bounded remote model-catalog refresh; also the model runtime behind `credentials.refresh` (`nodes/node-credentials.ts`) and the context for one-shot utility asks (system prompt only, no discovered resources)
- `pi/credential-store.ts` — adapts Pi's credential-store contract to Reins SQLite API-key/OAuth records
- `pi/model-catalog.ts` — provider listing/auth-source metadata built on top of Pi's model runtime (`buildProviderList`, `listRuntimeProviders` for `GET /api/models` and `models.list`), and single-model lookup (`findPiModel`, used to validate model changes)
- `pi/pending-operation.ts` — reads a session's durable pending operation from its storage for session views
- `pi-storage.ts` (`PiStorageAdapter`, in `src/`) — AgentHarness SQLite storage, the only copy of every session: the server serves the node's `storage.read`/`storage.commit` from it (`nodes/node-storage.ts`) and reads transcripts (`messages-store.ts`, `models/session-context.ts`); `pi-session-store.ts` holds only the admission proof the outbox deduplicates input against (`storedInput`); nothing else writes server Pi tables
- `pi/utility.ts` — runs non-persisted utility prompts (`askWithPi`) for task generation

## Dependency rules

- Stores don't import git, models, routes, or tools.
- Models don't import routes, tools, or ws.
- Routes, tools, and ws don't import each other.
- All layers can import stores and utilities.

## Current state

The models layer covers all route handlers and some backend domain helpers:

- `models/tasks.ts` — task create/update/delete with branch orchestration, list with diff stats
- `models/workspace.ts` — checkout-scoped file and diff behavior. `Workspace` selects the `WorkingTreeFileSystem` or `GitTreeFileSystem` adapter for file reads and owns changed-file summaries and raw patch streams, run through the source's `Git` (untracked files diff through a temporary index the `Git` builds beside the checkout). The filesystem interface, shared path policy, and adapters live in their own `models/*-file-system.ts` modules. `WorkingTreeFileSystem` still reads the server's checkout until `fs.read` exists. File routes must obtain content through this model rather than accessing the checkout directly.
- `models/projects.ts` — project creation, remote sync + task reconciliation, directory listing, and uploads; exposes scoped model getters such as `workspace`
- `models/sessions.ts` — session model mutations, including custom display names and explicit independent pin/archive timestamps, cursor-paginated display message reads, attachment upload/fetch, and related broadcast behavior. Normal session lists exclude archived rows and order pinned rows first while preserving activity recency within each group. Opening a session and runtime activity do not alter archive state. Initial display reads return the latest backward-paginated window; opaque `before` cursors load history and opaque `after` cursors synchronize every forward page from the persisted tail. Display page items expose stable `id` and nullable `parentId` links; the current linear transcript points each item to the immediately preceding persisted message, including parents outside the returned window. Soft page boundaries keep assistant tool calls with their persisted results in both directions.
- `models/uploaded-file.ts` — wraps browser `File` uploads at the HTTP/model boundary and extracts validated attachment bytes/metadata
- `models/model-settings.ts` — thinking-level schema/parsing plus resolution of stored model settings against a Pi model runtime
- `models/broadcast.ts` — typed broadcast abstraction over WS clients
