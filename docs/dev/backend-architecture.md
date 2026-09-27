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

Session orchestration is exposed as `api.sessions.start/send/wait` through search/execute, not specialized delegation tools. `runtimes/session-manager.ts` owns session creation (always for a node: the row and its `session.provision` are stored together); the server opens no runtime. Runtime assembly/cache is on the node (`packages/node/src/node.ts`, `packages/node/src/runtime/build.ts`). `SessionManager.forSession()` returns a caller-scoped `SessionInstance` from `runtimes/session-instance.ts`; that instance owns scope and child-depth policy, addressed prompt or steering submission to the outbox, bounded waits over server projections, and applying node lifecycle reports (activity, metadata, child settlement reports). Addressed sends always enter through native steering on the node so AgentHarness joins active work or starts/resumes idle work; there is no Reins-managed follow-up queue. The scripting facade and node lifecycle reports use the same instance. The tool abort signal is passed only to bounded observation; cancelling a wait never invokes the target runtime's abort. See [runtime-adapter-contract.md](runtime-adapter-contract.md#asynchronous-session-orchestration).

### WebSocket handlers (`src/ws.ts`)

Command dispatch for `prompt`, `steer`, `abort`. Prompt and steer messages are validated at the WS boundary and use block-only content (`[{ type: "text", text }]` plus optional image refs), then persisted to the node command outbox. WS does not expand skills or hydrate attachments; the node expands slash skills with the bound source cwd and hydrates attachments at the provider boundary. Abort is forwarded to the session's node; a session at rest on the server answers "Session not active".

### Models (`src/models/`)

Business logic: orchestrates stores, git operations, validation, and WS broadcasts. Model functions throw on failure — callers decide how to surface errors (HTTP status, tool error result, etc.).

WS broadcasts for state changes live here so every caller gets them automatically.

### Stores (`src/*-store.ts`)

Thin SQLite access. CRUD operations and queries, including DB-backed read projections used by scripting APIs. No git, no broadcasts, no business logic beyond what the DB enforces.

### Migrations (`src/migrations.ts`)

Schema-only migrations can be SQL strings. Data migrations that need application logic (for example JSON tree rewrites, hashing, or BLOB creation) should live under `src/migrations/` and be imported into the same ordered migration list.

### Utilities

- `src/git.ts` — low-level git operations (branch, checkout, refs, blobs, diff streams). Raw process runners stay internal; add semantic helpers instead of exporting command runners.
- `src/branch-namer.ts` — branch name generation and slugification
- `src/task-generator.ts` — LLM-powered task generation from freeform input

Stateless helpers that don't depend on other layers.

### Runtime adapters (`src/runtimes/`)

**The server never executes sessions.** Every session runs on a node; `sessions.placement_status` is the single source of truth for where it lives (see node-contract.md *Session placement*). The server holds no live runtimes (`ServerState` is just the WS clients and the frontend dir).

- `runtimes/session-manager.ts` — session creation (queued for provisioning on a node)
- `runtimes/execution-target.ts` / `runtimes/internal-node-execution.ts` — the one execution target: every command goes to the session's node; a session at rest on the server is hydrated first
- `runtimes/registry.ts` — per-runtime-type model catalog (`listModels`) and utility asks (`ask`); no session runtimes
- `runtimes/pi/` — Pi as a library: model catalog, credential store, context factory (credentials, OAuth refresh) and ephemeral utility calls
- `runtimes/claude_agent_sdk/` — dormant, unregistered Claude SDK implementation (to be rebuilt on AgentHarness); its execution types are in `runtime-types.ts`

### Internal node/source affinity

`nodes` identifies execution hosts; `sources` binds a project to a host-local path. Existing projects receive an internal source on migration; newly created projects get one automatically, and path updates follow the original internal source. Sessions persist `source_id` alongside `project_id`, with SQLite triggers enforcing project/source agreement. The node opens a session in its bound source path rather than the project's current path. Browser prompt/steer/abort and explicit resume enter `runtimes/node-execution.ts`. Server submission persists input and wakes `models/node-command-dispatcher.ts`; the dispatcher resolves source and explicit node binding from product rows, then delivers node-owned commands to the instance started in `handler.install()` via `runtimes/internal-node.ts`. `models/node-command-projection.ts` owns submission/projection and the wake hint. `packages/node/src/node.ts` owns provision binding, node SQLite canonical storage, Pi assembly/live runtime cache and addressed command execution. `runtimes/internal-node.ts` serves the node's calls (commits, lifecycle reports, attachments, credentials, tool calls) over its link. Sessions at rest on the server (`placement_status = 'server'`) are never run on the server: their next use hydrates them onto their source's node (`models/session-ownership.ts`, `runtimes/session-relocation.ts`; see node-contract.md *Session relocation*). Non-internal sources cannot run locally. Server replica application and its watermarks remain server-owned. Scripting-directed sends, waits and model changes go through the outbox and server projections.

### Pi integration (`src/runtimes/pi/`)

The server uses Pi only as a library; no session runtime is built on the server.

Key entry points:

- `pi/factory.ts` — adapts product SQLite credentials to `@reins/node/runtime` Pi model/resource context creation, including bounded remote model-catalog refresh; also the model runtime behind `credentials.refresh` (`runtimes/node-credentials.ts`)
- `pi/credential-store.ts` — adapts Pi's credential-store contract to Reins SQLite API-key/OAuth records
- `pi/model-catalog.ts` — provider listing/auth-source metadata built on top of Pi's model runtime
- `pi/agent-harness-adapter.ts` — the registered `pi` adapter: model catalog and utility asks only
- `pi/pending-operation.ts` — reads a session's durable pending operation from the replica for session views
- `@reins/node/pi-storage` — canonical AgentHarness SQLite storage: the server uses it to apply node replica batches (`node-replica.ts`), read transcripts (`pi-session-store.ts`) and summarize/page snapshots for hydration; nothing else writes server Pi tables
- `pi/utility.ts` — runs non-persisted utility prompts for task generation and branch naming

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
- `models/auth-credentials.ts` — auth credential mutations plus live session auth reload orchestration
- `models/model-settings.ts` — thinking-level schema/parsing plus resolution of stored model settings into concrete pi model objects
- `models/broadcast.ts` — typed broadcast abstraction over WS clients
