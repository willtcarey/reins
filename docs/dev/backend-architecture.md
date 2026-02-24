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

Agent tool definitions using the pi SDK `customTools` mechanism. Each tool file exports a factory that returns a `ToolDefinition`. The barrel `tools/index.ts` exports `createCustomTools()` which is the single integration point for `sessions.ts`.

Tool factories receive stable references (server state, session ID) at factory time and look up project context from the DB at execution time.

**Current tools:**

- **`create_task`** — creates a task with a git branch. Available in all sessions. Optional `prompt` parameter kicks off a fire-and-forget session on the new task.
- **`delegate`** — spawns a sub-session on the same task with a fresh context window, awaits completion, returns a summary. Only available in task sessions. Depth-limited (max 3), serialized per project via an in-memory mutex. See [ADR-005](../adr/005-orchestrator-loop-not-relay-chain.md) for the orchestrator-loop design choice.

### WebSocket handlers (`src/ws.ts`)

Command dispatch for `prompt`, `steer`, `abort`. Resolves project context from the session's DB row.

### Models (`src/models/`)

Business logic: orchestrates stores, git operations, validation, and WS broadcasts. Model functions throw on failure — callers decide how to surface errors (HTTP status, tool error result, etc.).

WS broadcasts for state changes live here so every caller gets them automatically.

### Stores (`src/*-store.ts`)

Thin SQLite access. CRUD operations and queries. No git, no broadcasts, no business logic beyond what the DB enforces.

### Utilities

- `src/git.ts` — git operations (branch, checkout, diff, etc.)
- `src/branch-namer.ts` — branch name generation and slugification
- `src/task-generator.ts` — LLM-powered task generation from freeform input

Stateless helpers that don't depend on other layers.

## Dependency rules

- Stores don't import git, models, routes, or tools.
- Models don't import routes, tools, or ws.
- Routes, tools, and ws don't import each other.
- All layers can import stores and utilities.

## Current state

Only `models/tasks.ts` exists so far. Other model files should be extracted as those areas are touched — no big-bang refactor. See [tech debt](../tech-debt.md) for the tracking item.
