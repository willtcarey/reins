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

### Tools (`src/tools/`)

Agent tool definitions using the pi SDK `customTools` mechanism. Each tool file exports a factory that returns a `ToolDefinition`. Session materialization (`runtimes/sessions-manager.ts`) resolves canonical custom tools once per session; runtimes consume that shared set and only map built-ins to their native wiring.

Tool factories receive stable references (server state, session ID) at factory time and look up project context from the DB at execution time.

**Current tools:**

- **`create_task`** — creates a task with a git branch. Available in all sessions. Optional `prompt` parameter kicks off a fire-and-forget session on the new task.
- **`search`** — discovers the curated `execute` API surface by returning documentation-only TypeScript interfaces from `src/scripting/api-registry.ts`.
- **`execute`** — runs an async JavaScript function body in a VM with only the curated `api` object in scope. Scripting functions live under `src/scripting/`; session-analysis helpers should extend `api.sessions` rather than introducing a separate analytics namespace. Keep `src/scripting/*` as execute/search glue: TypeBox schemas, descriptions/tags, project/task access checks, and delegation to stores/models. DB-backed filtering/extraction logic (for example session entry/message/tool-call extraction) belongs in `src/*-store.ts` so scripting is not the source of truth.

Session orchestration is exposed as `api.sessions.start/send/wait` through search/execute, not specialized delegation tools. `models/session-orchestration.ts` owns lifecycle/scope policy, explicit parent choices, and bounded observation; adapters own execution and native steering. Sending starts/resumes idle sessions or steers busy ones, with explicit unsupported errors and no queued follow-ups. Addressed delivery lives in `models/session-messages.ts`: its `send(sessionId, message)` opens the recipient, prompts or steers, and broadcasts. The scripting facade applies caller scope before using it. A separate runtime parent-report subscriber awaits persistence flush and uses the same messaging module; persistence does not call reporting. Creation/open capabilities and the tool abort signal are injected into execute context. Wait cancellation never invokes the target runtime's abort. See [runtime-adapter-contract.md](runtime-adapter-contract.md#asynchronous-session-orchestration).

### WebSocket handlers (`src/ws.ts`)

Command dispatch for `prompt`, `steer`, `abort`. Prompt and steer messages are validated at the WS boundary and use block-only content (`[{ type: "text", text }]` plus optional image refs). WS does not expand skills or hydrate attachments; runtime orchestration expands slash-skill prompts, and runtime adapters hydrate attachment refs at the provider boundary. Resolves project context from the session's DB row.

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

- `runtimes/sessions-manager.ts` — runtime-agnostic session open/create orchestration
- `runtimes/registry.ts` — runtime contracts (`AgentRuntime`, `AgentRuntimeAdapter`) and adapter registration/lookup
- `runtimes/pi/` — pi runtime adapter + runtime wrapper (`PiRuntimeAdapter`, `PiAgentRuntime`) and pi runtime materialization/wiring

`ManagedSession` holds a runtime handle (`managed.runtime`) instead of a raw pi session.
Pi and Claude SDK implement this seam without requiring separate WS/session orchestration.

### Pi integration (`src/runtimes/pi/`)

Pi-specific runtime boot/reopen behavior lives under `src/runtimes/pi/`.

Key entry points:

- `pi/factory.ts` — creates the cwd-scoped resource loader and Pi `ModelRuntime`, including bounded remote model-catalog refresh
- `pi/credential-store.ts` — adapts Pi's credential-store contract to Reins SQLite API-key/OAuth records
- `pi/model-catalog.ts` — provider listing/auth-source metadata built on top of Pi's model runtime
- `pi/session.ts` and `pi/runtime.ts` — create, resume, and adapt Pi sessions to Reins' runtime contract

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
- `models/sessions.ts` — session model mutations, cursor-paginated display message reads, attachment upload/fetch, and related broadcast behavior. Initial display reads return the latest backward-paginated window; opaque `before` cursors load history and opaque `after` cursors synchronize every forward page from the persisted tail. Display page items expose stable `id` and nullable `parentId` links; the current linear transcript points each item to the immediately preceding persisted message, including parents outside the returned window. Soft page boundaries keep assistant tool calls with their persisted results in both directions.
- `models/uploaded-file.ts` — wraps browser `File` uploads at the HTTP/model boundary and extracts validated attachment bytes/metadata
- `models/auth-credentials.ts` — auth credential mutations plus live session auth reload orchestration
- `models/model-settings.ts` — thinking-level schema/parsing plus resolution of stored model settings into concrete pi model objects
- `models/broadcast.ts` — typed broadcast abstraction over WS clients
