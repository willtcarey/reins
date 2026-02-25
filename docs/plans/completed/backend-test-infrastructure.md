# Backend Test Infrastructure & RGR Workflow

**Goal:** Set up `bun:test` for the backend, backfill contract tests for all existing layers, and establish a strict Red-Green-Refactor workflow so the agent can work autonomously with confidence.

## Context

The backend has zero tests. The codebase is ~3200 lines across stores, git utilities, a router, route handlers, models, tools, and WebSocket handlers. We want comprehensive contract-level tests — not testing implementation details, but specifying "given this input, this output/behavior" so that:

1. Future changes start by modifying a test (red), then implementing (green), then cleaning up (refactor).
2. An autonomous agent can run `bun test` to verify its work at every step.
3. The test suite is fast enough to run on every change (~seconds, not minutes).

## Principles

- **Tests describe contracts, not implementations.** "Create a task, get it back, fields match" — not "the SQL uses RETURNING *".
- **Each test file mirrors a source file.** `src/foo.ts` → `src/__tests__/foo.test.ts`.
- **Test helpers are minimal and reusable.** A test DB helper and a test git repo helper cover most needs.
- **No mocking where real dependencies are cheap.** SQLite in-memory is instant. Temp git repos are fast. Only mock expensive/external things (LLM calls, pi SDK sessions).

## Production Code Changes Required

These are minimal, surgical changes to make the code testable without altering behavior.

### 1. ✅ `db.ts` — add `setDb()` and `resetDb()`

The DB is a module-level singleton initialized from `process.cwd()/.reins/reins.db`. Tests need to inject an in-memory database.

```ts
// Add to db.ts:
export function setDb(newDb: Database): void {
  db = newDb;
}

export function resetDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
```

No change to `getDb()` behavior — these are only called from test helpers.

### 2. ✅ `git.ts` — export `parseUnifiedDiff()` and `parseNumstat()`

These are pure parsers with non-trivial logic (hunk parsing, line numbering, file merging). Currently internal. Exporting them enables direct unit tests without needing a git repo.

## Test Infrastructure

### ✅ Directory structure

```
packages/backend/src/
  __tests__/
    helpers/
      test-db.ts          # In-memory DB setup/teardown
      test-repo.ts         # Temp git repo setup/teardown
      test-state.ts        # Minimal ServerState factory
    branch-namer.test.ts
    db.test.ts
    errors.test.ts
    git.test.ts
    git-parsers.test.ts
    models/
      tasks.test.ts
    project-store.test.ts
    router.test.ts
    routes/
      projects.test.ts
      sessions.test.ts
      tasks.test.ts
      diff.test.ts
      file.test.ts
      git.test.ts
      health.test.ts
    session-store.test.ts
    task-store.test.ts
    tools/
      create-task.test.ts
    ws.test.ts
```

### ✅ `helpers/test-db.ts`

Creates an in-memory SQLite database with migrations applied. Every test file that touches the DB calls `setupTestDb()` in `beforeEach` and `teardownTestDb()` in `afterEach` for full isolation.

```ts
import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { setDb, resetDb } from "../../db.js";

export function setupTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  setDb(db);
  return db;
}

export function teardownTestDb(): void {
  resetDb();
}
```

### ✅ `helpers/test-repo.ts`

Creates a temporary git repository with an initial commit. Returns the path and a cleanup function. Some tests need a remote, so there's an option to set one up (a bare repo as "origin").

```ts
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface TestRepo {
  dir: string;
  cleanup: () => void;
}

export async function createTestRepo(opts?: { withRemote?: boolean }): Promise<TestRepo> {
  const dir = mkdtempSync(join(tmpdir(), "reins-test-"));
  // git init, initial commit, optionally set up a bare remote
  // ...
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
```

### ✅ `helpers/test-state.ts`

Minimal `ServerState` factory for route/WS tests. No real sessions or clients.

```ts
import type { ServerState } from "../../state.js";

export function createTestState(overrides?: Partial<ServerState>): ServerState {
  return {
    sessions: new Map(),
    clients: new Set(),
    frontendDir: "/tmp/nonexistent",
    explicitModel: undefined,
    ...overrides,
  };
}
```

### ✅ `package.json` scripts

```json
{
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "test": "bun test",
    "test:watch": "bun test --watch"
  }
}
```

## Test Backfill — By Layer

### Phase 1: Pure functions & infrastructure

These have zero dependencies and test instantly.

**`errors.test.ts`** — `HttpError` construction, `badRequest`/`notFound`/`conflict` throw correctly with status and message.

**`branch-namer.test.ts`** — `slugifyBranchName()` contract:
- Normal titles → `task/slug`
- Special characters stripped
- Length capping at 50 chars
- Empty/whitespace → `task/untitled`
- Already-hyphenated input
- Unicode handling

**`git-parsers.test.ts`** — `parseUnifiedDiff()` and `parseNumstat()`:
- Empty input → empty array
- Single file, single hunk
- Multiple files, multiple hunks
- Add-only, remove-only, mixed diffs
- Renamed files, binary files (skipped)
- Hunk header parsing (line numbers)
- `parseNumstat` with binary entries (- - path)

**`router.test.ts`** — `createRouter()`:
- Route matching by method and path
- URL params extraction
- Middleware execution order
- `HttpError` caught and converted to JSON response
- Unexpected errors → 500
- No match → returns null
- Group prefixing and middleware inheritance

### Phase 2: Store layers (DB-backed)

Each test file: `setupTestDb()` in `beforeEach`, `teardownTestDb()` in `afterEach`.

**`project-store.test.ts`**:
- `createProject` → returns full row with id, timestamps
- `getProject` → returns row or null
- `listProjects` → ordered by `last_opened_at` DESC
- `updateProject` → partial updates, returns updated row
- `deleteProject` → returns true/false, row is gone
- `touchProject` → updates `last_opened_at`
- Unique constraint on path → throws

**`task-store.test.ts`**:
- `createTask` → returns full row with status "open"
- `getTask` → returns row or null
- `listTasks` → ordered with closed last, includes session counts
- `updateTask` → partial updates, touches `updated_at`
- `deleteTask` → cascades sessions and messages, returns true/false
- `markTasksClosed` → sets status, no-op on empty array
- `listOpenTasks` → only status="open"
- `touchTask` → updates `updated_at`
- `getTaskSessionIds` → returns session IDs for a task

**`session-store.test.ts`**:
- `createSession` → returns full row with defaults
- `getSession` → returns row or null
- `listSessions` → project-scoped, excludes task sessions, ordered by `updated_at`
- `listTaskSessions` → task-scoped
- `updateSessionMeta` → partial updates
- `persistMessages` → inserts new messages, idempotent on re-call
- `loadMessages` → ordered by seq, includes compaction markers
- `loadMessagesForLLM` → only post-compaction messages
- `applyCompaction` → inserts summary marker, prunes tool results

### Phase 3: Git utilities

Each test file: `createTestRepo()` in `beforeAll`/`beforeEach`, cleanup in `afterAll`/`afterEach`.

**`git.test.ts`**:
- `detectDefaultBranch` → finds main/master/develop, falls back to "main"
- `createBranch` / `branchExists` / `deleteBranch` → lifecycle
- `checkoutBranch` / `getCurrentBranch` → round-trip
- `getSpread` → ahead/behind counts after commits
- `getDiffStats` → addition/removal counts
- `getMergedBranches` → detects merged branches
- `getBranchTip` / `revParse` → SHA resolution
- `getDiff` → returns parsed DiffFile array with correct structure
- `getChangedFiles` → returns file summaries
- `rebaseBranch` → success case, conflict case (aborts and restores)
- `fetchOrigin` / `fetchAll` → false when no remote (no-remote repo)
- `pullBaseBranch` / `fastForwardBaseBranch` → with remote test repo

### Phase 4: Models

**`models/tasks.test.ts`** — `createTaskWithBranch()`:
- Creates git branch and DB row
- Derives branch name from title when not provided
- Appends suffix on branch collision
- Captures base commit SHA
- Calls broadcast with `task_updated`
- Throws on git failure (propagates)

Needs: test DB + test repo + broadcast spy.

### Phase 5: Route handlers

Test via `router.handle(request, state)` — no HTTP server needed. Each test sets up the DB (and git repo where needed) and verifies response status + JSON body.

**`routes/health.test.ts`** — `GET /api/health` → 200.

**`routes/projects.test.ts`**:
- `GET /api/projects` → list
- `POST /api/projects` → create with validation (missing fields, nonexistent path, duplicate path)
- `PATCH /api/projects/:id` → update, 404 on missing
- `DELETE /api/projects/:id` → delete, 404 on missing

**`routes/tasks.test.ts`**:
- `GET /tasks` → list with diff stats
- `GET /tasks/:taskId` → single task with sessions
- `PATCH /tasks/:taskId` → update
- `DELETE /tasks/:taskId` → cascade delete + branch cleanup + active session check
- `POST /tasks/generate` — requires LLM, test the validation (empty prompt → 400), mock the generation

**`routes/sessions.test.ts`**:
- `GET /sessions` → list
- `GET /sessions/:sessionId` → from memory or DB
- `POST /sessions` — requires pi SDK, test at integration level or mock

**`routes/diff.test.ts`** and **`routes/file.test.ts`**:
- Need a git repo with actual changes
- Test path traversal prevention in file route
- Test mode=branch vs mode=uncommitted
- Test branch query param behavior

**`routes/git.test.ts`**:
- `GET /git/spread` → returns counts
- `POST /git/push` → validation, delegates to git
- `POST /git/rebase` → validation, delegates to git
- Reconciliation logic (merged tasks get closed)

### Phase 6: Tools & WebSocket

**`tools/create-task.test.ts`** — `createTaskTool()`:
- Returns valid `ToolDefinition` shape
- `execute` creates task + branch, returns success result
- `execute` returns error result on failure
- Needs: test DB + test repo + broadcast spy

**`ws.test.ts`** — `handleWsOpen`, `handleWsMessage`, `handleWsClose`:
- Client tracking (add on open, remove on close)
- Invalid JSON → error message
- Missing sessionId → error message
- Unknown command → error message
- `abort` for non-active session → error
- The `prompt`/`steer` paths are hard to test without pi SDK — test the validation/error paths, defer happy path to integration tests

### Phase 7 (optional): Full integration smoke test

A small test that starts a real `Bun.serve`, makes HTTP requests, and connects a WebSocket. Verifies the full stack wiring. Not needed for RGR to work — it's a bonus confidence layer.

## Things We Won't Test Directly

- **`generateBranchName()` LLM path** — the pi SDK session is expensive to set up and calls a real LLM. We test `slugifyBranchName()` (the fallback) thoroughly. The LLM path is a best-effort enhancement.
- **`generateTask()` LLM path** — same reasoning. Test the `fallback()` function behavior and the JSON parsing/validation logic by testing with pre-canned strings if we extract that.
- **`sessions.ts` full lifecycle** — `createNewSession`/`resumeSession` deeply couple to the pi SDK (`createAgentSession`, `DefaultResourceLoader`, etc.). We test the parts that don't need the SDK (store calls, broadcast wiring) and defer the full lifecycle to integration tests.
- **Hot reload mechanism** in `index.ts` — runtime dev tooling, not business logic.

## Documentation Changes

### AGENTS.md — add a workflow pointer

Keep it brief. Add a single section that points to the detailed doc. Scoped to implementation work so scratch/assistant sessions aren't burdened with it — they're for exploration and analysis, not code changes.

```markdown
## Development Workflow

When implementing code changes, follow the workflow in [docs/dev/workflow.md](docs/dev/workflow.md). Read it before starting implementation work.
```

### New: `docs/dev/workflow.md` — the implementation playbook

This is the doc the agent reads before making any change. It covers the full lifecycle, not just testing. Sections:

1. **Before you start**
   - Check for a planning doc in `docs/plans/` for the work you're doing.
   - Read relevant `docs/dev/` docs for the area you're touching (e.g. `router.md` before adding routes, `backend-architecture.md` for layer rules).
   - Check `docs/tech-debt.md` for known issues in the area.

2. **Red-Green-Refactor**
   - **Red:** Write a failing test that describes the desired behavior. Run `bun test --filter <test-file>` and confirm it fails for the right reason.
   - **Green:** Write the minimum code to make the test pass. Run the test again and confirm it passes.
   - **Refactor:** Clean up the implementation. Run the full suite with `bun test` to confirm nothing broke.
   - Every new feature, behavior change, or bug fix starts with a failing test. No exceptions.
   - When changing existing behavior, update the test first to reflect the new contract (red), then update the code (green).

3. **Testing reference**
   - How to run tests: `bun test`, `bun test --filter <pattern>`, `bun test --watch`
   - Test files live in `packages/backend/src/__tests__/`, mirroring the source structure.
   - Test helpers: `test-db.ts` (in-memory SQLite), `test-repo.ts` (temp git repos), `test-state.ts` (minimal ServerState).
   - Tests describe contracts (inputs → outputs), not implementation details.
   - Use real dependencies where cheap (SQLite, git repos). Only mock expensive externals (LLM calls, pi SDK sessions).

4. **Before you finish**
   - Run `bun test` and confirm the full suite passes.
   - Update or create docs:
     - `docs/features/` if user-facing behavior changed.
     - `docs/dev/` if internal conventions or architecture changed.
     - `docs/dev/INDEX.md` if you added a new dev doc.
   - Suggest tech debt items you noticed (don't add without confirmation).
   - If a planning doc in `docs/plans/` is fully implemented, move it to `docs/plans/completed/`.

### Update: `docs/dev/INDEX.md`

Add entries for the new docs:

```
| [workflow.md](workflow.md) | all | Development workflow: RGR, documentation, pre/post-implementation checklist |
```

## Implementation Order

The phases above are ordered by dependency. Within each phase, individual test files are independent and can be done in any order. The recommended sequence:

1. ✅ Production code changes (db.ts, git.ts exports) — 2 small edits
2. ✅ Test helpers (test-db, test-repo, test-state) + package.json scripts
3. Phase 1: Pure functions (errors, branch-namer, git-parsers, router)
4. Phase 2: Stores (project, task, session)
5. Phase 3: Git utilities
6. Phase 4: Models
7. Phase 5: Routes
8. Phase 6: Tools & WebSocket
9. `docs/dev/workflow.md` + AGENTS.md pointer + `docs/dev/INDEX.md` update
10. Phase 7: Integration smoke test (optional)

Phases 1-4 are the critical mass — once those are done, the RGR workflow is viable for most changes. Phases 5-6 extend coverage to the HTTP and tool layers. Phase 7 is a nice-to-have.
