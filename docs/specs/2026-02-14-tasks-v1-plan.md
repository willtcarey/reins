# Tasks v1 — Implementation Plan

**Spec:** [2026-02-14-tasks-v1.md](./2026-02-14-tasks-v1.md)
**Date:** 2026-02-15

---

## Overview

This plan breaks the Tasks v1 spec into ordered, reviewable steps. Each step is scoped to be independently testable. Dependencies flow top-down — later steps build on earlier ones.

---

## Step 1 — Database: `tasks` table + sessions FK

**Files:** `packages/backend/src/migrations.ts`

Add two migrations to the `MIGRATIONS` array:

1. **`006_create_tasks`** — Create the `tasks` table:
   ```sql
   CREATE TABLE tasks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     description TEXT,
     branch_name TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_tasks_project ON tasks(project_id, updated_at DESC);
   ```

2. **`007_add_session_task_id`** — Add nullable `task_id` FK to `sessions`:
   ```sql
   ALTER TABLE sessions ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
   ```

**Verification:** Server starts cleanly; `SELECT * FROM tasks` works; `sessions.task_id` column exists and defaults to NULL.

---

## Step 2 — Task Store (CRUD)

**New file:** `packages/backend/src/task-store.ts`

Follows the same pattern as `project-store.ts` and `session-store.ts`.

Functions:
- `createTask(projectId, title, description, branchName) → TaskRow`
- `getTask(id) → TaskRow | null`
- `listTasks(projectId) → TaskListItem[]` — ordered by `updated_at DESC`, includes session count
- `updateTask(id, { title?, description? }) → TaskRow | null` — touches `updated_at`
- `touchTask(id)` — update `updated_at` timestamp

Types:
```ts
interface TaskRow {
  id: number; project_id: number; title: string;
  description: string | null; branch_name: string;
  created_at: string; updated_at: string;
}
interface TaskListItem extends TaskRow {
  session_count: number;
}
```

**Verification:** Unit-level: import and call each function against a test DB.

---

## Step 3 — Git: Branch Creation + Branch Diff

**File:** `packages/backend/src/git.ts`

Add:

1. **`createBranch(projectDir, branchName, baseBranch)`** — Runs `git branch <branchName> <baseBranch>`. Throws if the branch already exists (non-zero exit).

2. **`branchExists(projectDir, branchName) → boolean`** — Runs `git show-ref --verify --quiet refs/heads/<branchName>`.

3. **`checkoutBranch(projectDir, branchName)`** — Runs `git checkout <branchName>`. Used when starting a task session.

4. **`getHighlightedBranchDiff(projectDir, baseBranch, taskBranch, contextLines)`** — Like `getHighlightedDiff` but diffs `baseBranch..taskBranch` (committed only, no working tree). Reuses the existing `parseUnifiedDiff` + highlighting pipeline. For reading file blobs, use `readBlob` at each ref rather than `readWorkingFile`.

**Verification:** Manual: create a branch, verify it exists, check it out, produce a diff.

---

## Step 4 — Branch Name Generation (LLM)

**New file:** `packages/backend/src/branch-namer.ts`

Given a task title, call a fast/cheap LLM (e.g. Haiku) to produce a slug like `task/refactor-auth-middleware`.

```ts
async function generateBranchName(title: string): Promise<string>
```

- Prompt: system message instructing the model to return *only* a git branch name in `task/<slug>` format, no explanation.
- Strip any whitespace/quotes from the response.
- Validate: must match `/^task\/[a-z0-9][a-z0-9\-]*$/` — if not, fall back to a simple slugify of the title (`task/${slugify(title)}`).
- Use `@anthropic-ai/sdk` directly for this one-shot call (no pi session needed).

**Open question:** Which model/provider to use. Haiku is cheapest. We can hardcode `claude-3-5-haiku-20241022` for now and make it configurable later.

**Verification:** Call with a few titles, verify output format.

---

## Step 5 — Task API Routes

**New file:** `packages/backend/src/routes/tasks.ts`

Register under the project group (with `projectMiddleware`).

### `GET /api/projects/:id/tasks`
- Calls `listTasks(projectId)`.

### `POST /api/projects/:id/tasks`
- Body: `{ title, description? }`
- Validate title is non-empty.
- Call `generateBranchName(title)` to get branch name.
- Call `branchExists()` — if collision, return 409.
- Call `createBranch(projectDir, branchName, project.base_branch)`.
- Call `createTask(projectId, title, description, branchName)`.
- Return 201 with the task row.

### `GET /api/projects/:id/tasks/:taskId`
- Calls `getTask(taskId)`.
- Also fetches sessions for the task: `listTaskSessions(taskId)`.
- Returns `{ ...task, sessions: [...] }`.

### `PATCH /api/projects/:id/tasks/:taskId`
- Body: `{ title?, description? }`
- Calls `updateTask(taskId, body)`.

**File:** `packages/backend/src/api-paths.ts` — Add:
```ts
tasks:        "/api/projects/:id/tasks",
task:         "/api/projects/:id/tasks/:taskId",
taskSessions: "/api/projects/:id/tasks/:taskId/sessions",
```

**File:** `packages/backend/src/routes/index.ts` — Register `registerTaskRoutes(r)` in the project group.

**Verification:** curl all endpoints; confirm branch is created on disk after POST.

---

## Step 6 — Task Sessions (Backend)

### Session Store Changes

**File:** `packages/backend/src/session-store.ts`

- `createSession()` — accept optional `taskId` param; include in INSERT.
- `listSessions(projectId)` — add `WHERE task_id IS NULL` to only return scratch sessions.
- New: `listTaskSessions(taskId) → SessionListItem[]` — sessions for a specific task, ordered by `updated_at DESC`.
- `SessionRow` — add `task_id: number | null`.

### Task Session Route

**File:** `packages/backend/src/routes/tasks.ts` (same file, or a new `task-sessions.ts`)

**`POST /api/projects/:id/tasks/:taskId/sessions`**
- Verify task exists and belongs to project.
- Call `createNewSession(state, projectId, projectDir, { taskId })`.
- Return 201.

**`GET /api/projects/:id/tasks/:taskId/sessions`**
- Calls `listTaskSessions(taskId)`.

### Session Creation Changes

**File:** `packages/backend/src/sessions.ts`

- `createNewSession()` — accept optional `taskId`. Pass to `dbCreateSession()`.
- When `taskId` is set:
  - Look up the task to get `branch_name`.
  - Run `checkoutBranch(projectDir, task.branch_name)` before creating the pi session.
  - Build a system prompt prefix with the task title/description (see Step 7).
- `resumeSession()` — similarly, if the session has a `task_id`, check out the task branch before resuming.

**Verification:** Create a task, create a session under it, confirm branch is checked out, confirm session works.

---

## Step 7 — System Prompt Injection

**File:** `packages/backend/src/sessions.ts`

When creating or resuming a task session, prepend to the system prompt:

```
## Task
Title: {task.title}
Description: {task.description}

You are working on this task.
```

This requires passing a `systemPrompt` option to `createAgentSession()`. Check pi SDK docs for how to inject/prepend system prompt content. If the SDK supports a `systemPrompt` field, use it. Otherwise, we may need to prepend a system message to the messages array.

**Verification:** Start a task session, inspect the first message or system prompt to confirm task context is present.

---

## Step 8 — Diff Route: Task Branch Diffs

**File:** `packages/backend/src/routes/diff.ts`

Modify `GET /api/projects/:id/diff` to accept an optional `?taskId=` query param:

- If `taskId` is present: look up the task, call `getHighlightedBranchDiff(projectDir, project.base_branch, task.branch_name, contextLines)` — committed-only diff between base and task branch.
- If absent: existing behavior (working tree diff).

**Verification:** Create a task with commits on its branch, hit `/diff?taskId=X`, see the branch diff.

---

## Step 9 — Frontend: Sidebar Redesign

**File:** `packages/frontend/src/session-sidebar.ts` (major rewrite)

The sidebar becomes the **task-oriented view** described in the spec. Rename component to `task-sidebar` (or keep the element name and refactor in place).

### Layout (top to bottom):
1. **Project switcher** (existing `<project-sidebar>`, unchanged)
2. **"New Task" button**
3. **Tasks section** — list of tasks, most recently updated first
   - Each task shows: title, session count, last updated
   - Clicking a task expands it to show its sessions
   - Each session is clickable (loads into chat panel)
   - Expanded task has a "+ New Session" button
4. **Divider**
5. **"Scratch Sessions" section** — standalone sessions (existing behavior)
   - "+ New Session" button for scratch sessions
   - Session list (same rendering as today)

### Data fetching:
- On project load, fetch both `GET /tasks` and `GET /sessions` (scratch).
- On task expand, fetch `GET /tasks/:taskId/sessions` (or use data from `GET /tasks/:taskId`).

### New Task dialog:
- Inline form or minimal modal: title input (required), description textarea (optional).
- POST to `/tasks`, then refresh the list.

### Events:
- Dispatch the same `loadSession` call to `app-shell` when a session (task or scratch) is selected. The `task_id` is included in the session data from the API — no separate tracking needed.

**Verification:** Visual: sidebar shows tasks and scratch sessions; can create tasks, expand them, create task sessions, switch between them.

---

## Step 10 — Frontend: App Shell + Diff Panel Integration

**File:** `packages/frontend/src/app.ts`

- Derive `activeTaskId` from `sessionData.task_id` (included in the session API response). No new URL routes or component state needed.
- Pass `activeTaskId` to `<diff-panel>`.

**File:** `packages/frontend/src/diff-panel.ts`

- Accept a `taskId` property.
- When `taskId` is set, append `?taskId=X` to the diff fetch URL.
- When `taskId` is null (scratch session), use existing behavior.

**File:** `packages/frontend/src/ws-client.ts`

- Update `SessionData` type to include optional `task_id`.

**Verification:** Switch between task sessions and scratch sessions; diff panel shows the correct diff for each context.

---

## Step Summary

| Step | Scope | Key Files |
|------|-------|-----------|
| 1 | DB migrations | `migrations.ts` |
| 2 | Task CRUD store | `task-store.ts` (new) |
| 3 | Git branch ops | `git.ts` |
| 4 | Branch name gen | `branch-namer.ts` (new) |
| 5 | Task REST API | `routes/tasks.ts` (new), `api-paths.ts`, `routes/index.ts` |
| 6 | Task sessions backend | `session-store.ts`, `sessions.ts`, `routes/tasks.ts` |
| 7 | System prompt injection | `sessions.ts` |
| 8 | Branch diff endpoint | `routes/diff.ts`, `git.ts` |
| 9 | Sidebar redesign | `session-sidebar.ts` |
| 10 | App shell + diff wiring | `app.ts`, `diff-panel.ts`, `ws-client.ts` |

---

## Risks & Open Questions

1. **Branch checkout conflicts** — Checking out a task branch when the working tree is dirty will fail. The spec says "no automatic stashing or cleaning." We should surface a clear error to the user when this happens. Consider: should we show the error in the UI, or just in the session creation failure response?

2. **Concurrent tasks** — Two task sessions for different tasks can't both have their branch checked out simultaneously (single working tree). This is explicitly out of scope for v1, but we should at minimum warn or error if a user tries to run two task sessions that need different branches. A simple guard: track which branch is currently checked out in server state, and reject session creation if it would require a branch switch while another task session is active/streaming.

3. **LLM dependency for branch naming** — The `generateBranchName` call adds latency and a network dependency to task creation. The slugify fallback ensures task creation never fails due to LLM issues, but we should make the timeout aggressive (e.g., 5s).

4. **System prompt injection** — Need to verify the pi SDK's `createAgentSession` supports a `systemPrompt` option. If not, we'll prepend a system-role message to the messages array.

5. **Task deletion** — Deferred from v1. Tasks persist indefinitely; users manage cleanup via git branches. Can revisit when status lifecycle is added.
