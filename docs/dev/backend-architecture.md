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

Application tools are native `AgentHarnessTool` definitions. Each tool file exports a factory using the harness execution signature, including the harness `Context`; `execute` forwards `context.abortSignal` into the scripting API. For legacy sessions, `runtimes/session-manager.ts` resolves these tools once per session; for new node-owned sessions the in-process product-policy callback in `runtimes/internal-node.ts` supplies them to node assembly. A separate legacy projection exists only to keep the dormant Claude SDK implementation compiling and is not used by the registered runtime.

Tool factories receive stable references (server state, session ID) at factory time and look up project context from the DB at execution time.

**Current tools:**

- **`create_task`** — creates a task with a git branch. Available in all sessions. Optional `prompt` parameter kicks off a fire-and-forget session on the new task.
- **`search`** — discovers the curated `execute` API surface by returning documentation-only TypeScript interfaces from `src/scripting/api-registry.ts`.
- **`execute`** — runs an async JavaScript function body in a VM with only the curated `api` object in scope. Scripting functions live under `src/scripting/`; session-analysis helpers should extend `api.sessions` rather than introducing a separate analytics namespace. Keep `src/scripting/*` as execute/search glue: TypeBox schemas, descriptions/tags, project/task access checks, and delegation to stores/models. DB-backed filtering/extraction logic (for example session entry/message/tool-call extraction) belongs in `src/*-store.ts` so scripting is not the source of truth.

Session orchestration is exposed as `api.sessions.start/send/wait` through search/execute, not specialized delegation tools. `runtimes/session-manager.ts` owns session creation and the retired legacy server-owned reopening/materialization (no longer used for execution: legacy sessions move onto the node on use); new node-owned runtime assembly/cache is in `packages/node/src/node.ts` and `packages/node/src/runtime/build.ts`. `SessionManager.forSession()` returns a caller-scoped `SessionInstance` from `runtimes/session-instance.ts`; that instance owns scope and child-depth policy, addressed prompt or steering admission, bounded waits, lifecycle persistence, and child settlement reports. Addressed sends always enter through native steering so AgentHarness joins active work or starts/resumes idle work without consulting a potentially stale streaming flag; there is no Reins-managed follow-up queue. The scripting facade and runtime lifecycle sink use the same instance. The tool abort signal is passed only to bounded observation; cancelling a wait never invokes the target runtime's abort. See [runtime-adapter-contract.md](runtime-adapter-contract.md#asynchronous-session-orchestration).

### WebSocket handlers (`src/ws.ts`)

Command dispatch for `prompt`, `steer`, `abort`. Prompt and steer messages are validated at the WS boundary and use block-only content (`[{ type: "text", text }]` plus optional image refs). WS does not expand skills or hydrate attachments; runtime orchestration calls the node-local slash-skill expander with the bound source cwd, and the current server builder injects attachment hydration at the provider boundary. Resolves project context from the session's DB row.

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

Agent execution is routed through a runtime abstraction:

- `runtimes/session-manager.ts` — runtime-agnostic session open/create orchestration
- `runtimes/registry.ts` — runtime contracts (`AgentRuntime`, `AgentRuntimeAdapter`) and adapter registration/lookup
- `runtimes/pi/` — the registered AgentHarness Pi adapter, canonical SQLite storage adapter, provider integration, and ephemeral utility calls

`ManagedSession` holds a runtime handle (`managed.runtime`) instead of exposing Pi internals. AgentHarness Pi is the only registered session runtime; the Claude SDK implementation remains in-tree but unregistered.

### Internal node/source affinity

`nodes` identifies execution hosts; `sources` binds a project to a host-local path. Existing projects receive an internal source on migration; newly created projects get one automatically, and path updates follow the original internal source. Sessions persist `source_id` alongside `project_id`, with SQLite triggers enforcing project/source agreement. The session manager reopens from the bound source path rather than assuming the project's current path. Browser prompt/steer/abort and explicit resume enter `runtimes/node-execution.ts`. Server submission persists input and wakes `models/node-command-dispatcher.ts`; the dispatcher resolves source and explicit node binding from product rows, then delivers node-owned commands to the instance started in `handler.install()` via `runtimes/internal-node.ts`. `models/node-command-projection.ts` owns submission/projection and the wake hint. `packages/node/src/node.ts` owns provision binding, node SQLite canonical storage, Pi assembly/live runtime cache and addressed command execution. `runtimes/internal-node.ts` injects an in-process product policy (settings/credentials, task branch, DB-backed tools, attachment hydration, lifecycle and UI observation); it does not call backend `SessionManager.open()` for node-owned sessions, and those runtime objects never enter `ServerState.sessions`. Legacy server-owned sessions are at rest on server SQLite and no longer run on the server: their next use hydrates them onto the node (`models/session-ownership.ts`, `runtimes/session-relocation.ts`; see node-contract.md *Session relocation*); `runtimes/legacy-session-execution.ts` routes their work there. Non-internal sources cannot run locally. Server replica application/receipts remain server-owned. This is still an in-process seam: custom tools, credentials, attachments, resource expansion, filesystem and git rely on the backend and local checkout; there is no external daemon or transport. Scripting-directed sends use source-bound command routing; in-process waits and model changes consult the node runtime cache without inserting its handles into the server map.

### Pi integration (`src/runtimes/pi/`)

Pi-specific runtime boot/reopen behavior lives under `src/runtimes/pi/`.

Key entry points:

- `pi/factory.ts` — adapts product SQLite credentials to node-owned `@reins/node/runtime` Pi model/resource context creation, including bounded remote model-catalog refresh
- `pi/credential-store.ts` — adapts Pi's credential-store contract to Reins SQLite API-key/OAuth records
- `pi/model-catalog.ts` — provider listing/auth-source metadata built on top of Pi's model runtime
- `pi/agent-harness-adapter.ts` and `pi/agent-harness-builder.ts` — legacy server-owned Pi construction against server SQLite; node-owned rows are rejected. The builder combines `@reins/node/host-tools` native tools/env with product DB-backed tools. New node-owned Pi assembly lives in `packages/node/src/runtime/build.ts` with canonical binding/storage and injected product policy. Native run/drive/reopen lives in `@reins/node/pi-runtime` for both paths.
- `@reins/node/pi-storage` — reusable canonical AgentHarness SQLite storage; `pi/storage-adapter.ts` adds the server-only write guard for legacy sessions; the node owns new-session canonical SQLite and its pending commit outbox
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
