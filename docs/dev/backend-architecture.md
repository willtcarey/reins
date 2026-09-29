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

Agent tool definitions live on the node (`@reins/node/reins-tools`, assembled by the node's runtime builder). The server implements what they call: `tools/index.ts` (`serverToolCalls`) runs `script.execute`, `script.search` and `project.createTask` for the calling session, reached over the node link (`runtimes/node-tool-calls.ts`; see node-contract.md *Agent tools*). Scope comes from the server's session row at call time, never from the caller.

**Current tools:**

- **`create_task`** — creates a task with a git branch. Available in all sessions. Optional `prompt` parameter kicks off a fire-and-forget session on the new task.
- **`search`** — discovers the curated `execute` API surface by returning documentation-only TypeScript interfaces from `src/scripting/api-registry.ts`.
- **`execute`** — runs an async JavaScript function body in a VM with only the curated `api` object in scope. Scripting functions live under `src/scripting/`; session-analysis helpers should extend `api.sessions` rather than introducing a separate analytics namespace. Keep `src/scripting/*` as execute/search glue: TypeBox schemas, descriptions/tags, project/task access checks, and delegation to stores/models. DB-backed filtering/extraction logic (for example session entry/message/tool-call extraction) belongs in `src/*-store.ts` so scripting is not the source of truth.

Session orchestration is exposed as `api.sessions.start/send/wait` through search/execute, not specialized delegation tools. `runtimes/session-manager.ts` owns session creation (the row, on its source's node; the node creates Pi's lane when it first opens the session); the server opens no runtime. Runtime assembly/cache is on the node (`packages/node/src/node.ts`, `packages/node/src/runtime/build.ts`). `SessionManager.forSession()` returns a caller-scoped `SessionInstance` from `runtimes/session-instance.ts`; that instance owns scope and child-depth policy, addressed prompt or steering submission to the outbox, bounded waits over server projections, and applying node lifecycle reports (activity, metadata, child settlement reports). Addressed sends always enter through native steering on the node so AgentHarness joins active work or starts/resumes idle work; there is no Reins-managed follow-up queue. The scripting facade and node lifecycle reports use the same instance. The tool abort signal is passed only to bounded observation; cancelling a wait never invokes the target runtime's abort. See [node-runtime.md](node-runtime.md#session-orchestration).

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

- `src/git.ts` — low-level git operations (branch, checkout, refs, blobs, diff streams). Raw process runners stay internal; add semantic helpers instead of exporting command runners.
- `src/task-generator.ts` — LLM-powered task generation from freeform input, and branch-name slugification (`slugifyBranchName`)

Stateless helpers that don't depend on other layers.

### Runtimes and the node hub (`src/runtimes/`)

**The server never executes sessions.** Every session runs on a node; `sessions.placement_status` is the single source of truth for where it lives (see node-contract.md *Session placement*). The server holds no live runtimes: `ServerState` is the process state (WS clients, frontend dir) plus the installed handler's node hub, `state.nodes`.

- `runtimes/session-manager.ts` — session creation (placed on the caller's source or the project's default source)
- `runtimes/node-hub.ts` — the node hub of a handler install (`installNodeHub`): node links by node ID, the dispatcher, node→server services and submission failure recipients
- `runtimes/node-execution.ts` — `deliverToNode` (every command goes to the node of the session's source, with its binding, task snapshot and lane seed), input submission and immediate controls
- `runtimes/node-source.ts` — `resolveSessionSource`, session bindings and the default source policy
- `runtimes/node-server-handlers.ts` — node→server calls for one node ID, fenced by placement
- `runtimes/registry.ts` — runtime-neutral model catalog and utility-ask shapes (no adapter registry: callers use Pi's catalog and asks directly)
- `runtimes/pi/` — Pi as a library: model catalog, credential store, context factory (credentials, OAuth refresh) and ephemeral utility calls
- `runtimes/claude_agent_sdk/` — dormant, unregistered Claude SDK implementation (to be rebuilt on AgentHarness); its execution types are in `runtime-types.ts`. Its trace/repro scripts (`scripts/capture-claude-sdk-trace.ts`, `scripts/capture-compact-trace.ts`, `scripts/claude-sdk-missing-final-text-smoke.ts`) are dormant too; the last two no longer typecheck (scripts are outside the backend tsconfig)

### Nodes and sources

`nodes` identifies execution hosts; `sources` binds a project to a host-local path. Migration `029` seeds one node row (`internal`, the ID the local node process announces by default) and gives every project a source on it (existing projects on migration, new ones by trigger; path updates follow that original source). That ID is data only: **no server code singles out a node** (`node-dependency-boundary.test.ts` checks it). Sessions persist `source_id` alongside `project_id`, with SQLite triggers enforcing project/source agreement; a new session is placed on its caller's source or the project's default source (its first). The node opens a session in its bound source path rather than the project's current path. Browser prompt/steer/abort and explicit resume enter `runtimes/node-execution.ts`. Server submission persists input and wakes the hub (`state.nodes.wake()`); its dispatcher (`models/node-command-dispatcher.ts`) resolves each session's source (`resolveSessionSource`) and delivers to the link of that source's node while it is connected (`state.nodes.connected(nodeId)`); other work waits. Nodes connect by dialing (the local node over the process owner's Unix socket), announce their node ID in `node.hello`, and are served only if that node row exists. `packages/node/src/node.ts` owns provision binding, node SQLite canonical storage, Pi assembly/live runtime cache and addressed command execution. `runtimes/node-server-handlers.ts` serves each node's calls (commits, lifecycle reports, attachments, credentials, tool calls) over its link. Sessions at rest on the server (`placement_status = 'server'`) are never run on the server: their next use hydrates them onto their source's node (`models/session-ownership.ts`, `runtimes/session-relocation.ts`; see node-contract.md *Session relocation*). Server replica application and its watermarks remain server-owned. Scripting-directed sends, waits and model changes go through the outbox and server projections. See node-contract.md *Node hub*.

### Pi integration (`src/runtimes/pi/`)

The server uses Pi only as a library; no session runtime is built on the server.

Key entry points:

- `pi/factory.ts` — the server's own Pi model runtime over product SQLite credentials, built directly from Pi (not the node package), including bounded remote model-catalog refresh; also the model runtime behind `credentials.refresh` (`runtimes/node-credentials.ts`) and the context for one-shot utility asks (system prompt only, no discovered resources)
- `pi/credential-store.ts` — adapts Pi's credential-store contract to Reins SQLite API-key/OAuth records
- `pi/model-catalog.ts` — provider listing/auth-source metadata built on top of Pi's model runtime (`buildProviderList`, `listRuntimeProviders` for `GET /api/models` and `models.list`), and single-model lookup (`findPiModel`, used to validate model changes)
- `pi/pending-operation.ts` — reads a session's durable pending operation from its storage for session views
- `@reins/pi-sql-storage` — AgentHarness SQLite storage, the only copy of every session: the server serves the node's `storage.read`/`storage.commit` from it (`runtimes/node-server-handlers.ts`) and reads transcripts (`pi-session-store.ts`); nothing else writes server Pi tables
- `pi/utility.ts` — runs non-persisted utility prompts (`askWithPi`) for task generation

## Dependency rules

- Stores don't import git, models, routes, or tools.
- Models don't import routes, tools, or ws.
- Routes, tools, and ws don't import each other.
- All layers can import stores and utilities.

## Current state

The models layer covers all route handlers and some backend domain helpers:

- `models/tasks.ts` — task create/update/delete with branch orchestration, list with diff stats
- `models/workspace.ts` — checkout-scoped file and diff behavior. `Workspace` selects the `WorkingTreeFileSystem` or `GitTreeFileSystem` adapter for file reads and owns changed-file summaries, raw patch streams, parsed diff DTOs, and temporary indexes for untracked-file diffing. The filesystem interface, shared path policy, and adapters live in their own `models/*-file-system.ts` modules. This is the local workspace implementation; a future node-aware workspace seam may add a remote implementation without exposing filesystem access to callers. File routes must obtain content through this model rather than accessing the checkout directly.
- `models/projects.ts` — project creation, remote sync + task reconciliation, directory listing, and uploads; exposes scoped model getters such as `workspace`
- `models/sessions.ts` — session model mutations, including custom display names and explicit independent pin/archive timestamps, cursor-paginated display message reads, attachment upload/fetch, and related broadcast behavior. Normal session lists exclude archived rows and order pinned rows first while preserving activity recency within each group. Opening a session and runtime activity do not alter archive state. Initial display reads return the latest backward-paginated window; opaque `before` cursors load history and opaque `after` cursors synchronize every forward page from the persisted tail. Display page items expose stable `id` and nullable `parentId` links; the current linear transcript points each item to the immediately preceding persisted message, including parents outside the returned window. Soft page boundaries keep assistant tool calls with their persisted results in both directions.
- `models/uploaded-file.ts` — wraps browser `File` uploads at the HTTP/model boundary and extracts validated attachment bytes/metadata
- `models/model-settings.ts` — thinking-level schema/parsing plus resolution of stored model settings against a Pi model runtime
- `models/broadcast.ts` — typed broadcast abstraction over WS clients
