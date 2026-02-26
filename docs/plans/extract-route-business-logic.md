# Extract Route Business Logic

Audit of inline business logic in route handlers and WS command handlers.
Goal: identify what should move into a `models/` layer, following the pattern
established by `models/tasks.ts` and `models/broadcast.ts`.

## Reference Pattern

`models/tasks.ts` (`createTaskWithBranch`) is the gold standard:
- Orchestrates multiple steps (branch name derivation → collision check → git branch creation → store insert → broadcast)
- Exposes a single function that routes and tools both call
- Throws on failure; callers handle errors their own way
- Receives a `Broadcast` function rather than reaching into server state

## Already Clean

| File | Assessment |
|---|---|
| `routes/tasks.ts` — POST `/tasks` (create) | Delegates to `models/tasks.ts` ✅ |
| `routes/tasks.ts` — POST `/tasks/generate` | Delegates to `task-generator` + `models/tasks.ts` ✅ |
| `routes/tasks.ts` — GET `/tasks/:taskId` | Thin store read + serialize ✅ |
| `routes/tasks.ts` — GET `/tasks/:taskId/sessions` | Thin store read ✅ |
| `routes/tasks.ts` — POST `/tasks/:taskId/sessions` | Delegates to `sessions.ts` ✅ |
| `routes/sessions.ts` — all handlers | Thin delegation to `sessions.ts` ✅ |
| `routes/health.ts` | Pure read, no logic ✅ |
| `routes/projects.ts` — PATCH `/projects/:id` | Request normalization + thin store call ✅ |
| `routes/projects.ts` — DELETE `/projects/:id` | Thin store call ✅ |
| `routes/diff.ts` — both handlers | Thin delegation to `git.ts` helpers ✅ |
| `ws.ts` — `prompt` / `steer` / `abort` | Thin command dispatch ✅ |

## Inline Business Logic to Extract

### 1. `routes/projects.ts` — POST `/projects` (create)

**Inline logic:**
- Git default branch detection (`detectDefaultBranch`)
- Store call (`createProject`)
- UNIQUE constraint error → 409 conflict translation

Field validation (existence checks, trimming) stays in the route — that's
request preparation, not business logic.

**Target:** `models/projects.ts` — `createProject(params)` that encapsulates
branch detection, store insert, and constraint error mapping.

---

### 2. `routes/tasks.ts` — GET `/tasks` (list with diff stats)

**Inline logic:**
- Fetches all tasks, then enriches open ones with `getDiffStats` in parallel
- Per-task try/catch to gracefully handle missing branches

**Target:** `models/tasks.ts` — `listTasksWithDiffStats(projectId, projectDir, baseBranch)`.

---

### 3. `routes/tasks.ts` — PATCH `/tasks/:taskId` (update)

**Inline logic:**
- Store update + broadcast (`task_updated`) combined inline
- Constructs broadcast inline via `createBroadcast(ctx.state.clients)`

**Target:** `models/tasks.ts` — `updateTask(taskId, params, broadcast)` that
owns store update + broadcast as a unit.

---

### 4. `routes/tasks.ts` — DELETE `/tasks/:taskId`

**Inline logic — most complex handler in the codebase:**
- Ownership check (task belongs to project)
- Active session detection (iterates in-memory sessions, checks `isStreaming`)
- In-memory session cleanup (deletes from `state.sessions`)
- Store deletion (cascading)
- Broadcast (`task_updated`)
- Git branch cleanup: detect if branch is checked out → checkout base → delete branch
- Best-effort error handling for git cleanup

**Target:** `models/tasks.ts` — `deleteTaskWithBranch(taskId, projectId, projectDir, baseBranch, state, broadcast)`.
This is the delete counterpart to the existing `createTaskWithBranch`.

---

### 5. `routes/git.ts` — GET `/git/spread` (with `fetch=true`)

**Inline logic:**
- Conditional fetch + fast-forward sequence (`fetchAll` → `fastForwardBaseBranch`)
- Calls `reconcileClosedTasks` (a 60-line private function in the same file)
- `reconcileClosedTasks` itself is a complex orchestration: iterates open tasks,
  checks merged status, compares branch tips to base commits, marks tasks closed,
  broadcasts, and cleans up local branches

**Target:** `models/projects.ts` — `syncWithRemote(projectId, projectDir, baseBranch, broadcast)` that owns the fetch + fast-forward + task reconciliation sequence.
This is a project-level operation ("sync this project with its remote") that
reaches into git and task concerns as needed.

---

### 6. `routes/file.ts` — GET `/file`

**Inline logic:**
- Path traversal validation (resolve + normalize + prefix check)
- Decides git-read vs working-tree-read based on whether `ref` matches current branch
- Raw `Bun.spawn(["git", "show", ...])` call — the only place in the codebase
  that shells out to git directly instead of using the `git.ts` helper module

**Target:** `models/projects.ts` — `readFileContent(projectDir, filePath, ref?)`.
The `git show` call should move into `git.ts` as a `showFile(dir, ref, path)` helper
to match the existing pattern. Path traversal validation could stay in the route
or move into the model.

---

## Summary by Target Module

| Target Module | Items to Extract |
|---|---|
| `models/projects.ts` (new) | #1 create project, #5 sync with remote, #6 read file content |
| `models/tasks.ts` (extend) | #2 list with diff stats, #3 update + broadcast, #4 delete with branch cleanup |
| `git.ts` (extend) | #6 `showFile` helper for `git show ref:path` |

## Notes

- The `reconcileClosedTasks` function (#5) is the largest single piece of inline
  logic (~60 lines). It lives in `models/projects.ts` as part of `syncWithRemote`,
  since it's a project-level "sync with remote" operation that touches both git
  and task concerns.
- The delete-task handler (#4) is the second most complex, with state management,
  git operations, and store calls all interleaved.
- Several handlers construct `createBroadcast(ctx.state.clients)` inline. After
  extraction, the broadcast function should be passed in from the route layer
  (matching the existing `createTaskWithBranch` pattern).
