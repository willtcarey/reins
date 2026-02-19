# Git Remote Sync

## Goal

Surface git sync status in the UI so the user can see where task branches stand — relative to the base branch and the remote — and take action (push, rebase) without leaving the app.

## Task status

Tasks gain a `status` column: `open` (default) or `merged`. Status is stored in the database and reconciled automatically — not manually managed.

**Reconciliation:** after a `git fetch origin` + `pullBaseBranch`, run `git branch --merged baseBranch`. Any open tasks whose branch appears in that list are updated to `status = 'merged'`. This is a one-way latch — once merged, always merged.

This works even if the local task branch pointer hasn't advanced, because `git branch --merged` checks whether a branch's tip is reachable from the base branch (i.e., all its commits are in the base branch's history after the merge).

**Known limitation:** squash merges (e.g., GitHub squash-and-merge) create a new commit on the base branch rather than incorporating the original commits, so `git branch --merged` won't detect them.

## Sidebar — task items

Each task item currently shows the title, relative date, and session count. We add the branch name and line diff stats for open tasks:

```
▶ Add login feature
  feature/add-login  +42 -17
  2 min ago · 3 sessions
```

- **Branch name** in monospace, truncated if long
- **+N -N** total line additions/removals vs base branch, shown only for open tasks
- Data comes from `git diff --numstat baseBranch...taskBranch` — local only, cheap
- Diff stats are fetched alongside task list refreshes, only for open tasks
- Merged tasks are visually distinguished (dimmed or similar)

## Changes tab — sync status and actions

The diff panel header already shows the branch and base branch. We extend it with commit-level sync status and action buttons:

```
[⑂ feature/add-login] → main    2 unpushed    [Rebase 3] [Push]    Context: 3 lines
```

### Four numbers

For any task branch, there are four commit counts:

| # | What | Computation | Shown | Action |
|---|------|-------------|-------|--------|
| **Ahead of base** | Work done on the task branch since it diverged | `git rev-list --count baseBranch..branch` | Informational | — |
| **Behind base** | Base branch has moved since the task branched | `git rev-list --count branch..baseBranch` | `N behind main` | **Rebase** button |
| **Ahead of remote** | Unpushed commits on the branch | `git rev-list --count origin/branch..branch` | `N unpushed` | **Push** button |
| **Behind remote** | Someone else pushed to this branch on origin | `git rev-list --count branch..origin/branch` | `N behind origin` | Informational (rare) |

The first two are local only (instant). The last two require a `git fetch origin` to be current, but can be computed from stale local refs without fetching.

### UI details

- **N unpushed** — commits ahead of remote. Only shown when > 0.
- **N behind origin** — commits behind remote. Only shown when > 0. No action button for now.
- **Rebase N** button — shows the number of commits behind the base branch. Only shown when > 0. Triggers agentic rebase onto base branch — the agent runs `git rebase`, resolves any conflicts as a coding task, or aborts on failure.
- **Push** button — pushes current branch to origin. Shows loading/success/error.
- Remote data polled on a slower cadence (~60s, with `fetch=true`) and only while the Changes tab is visible.
- Local-only numbers (ahead/behind base) polled more frequently (with `fetch=false`).

## Backend

All stateless endpoints — no backend timers or background processes.

### git.ts additions

- `fetchAll(projectDir)` — runs `git fetch origin` to update all remote refs. Returns true if the fetch succeeded, false if there's no remote. Separate from any query — the endpoint calls this before querying when fresh data is needed.
- `getSpread(projectDir, branch, baseBranch)` — returns all four commit counts for a single branch using local refs only. Always instant. Returns `null` for remote numbers if no remote tracking branch exists.
- `getDiffStats(projectDir, branch, baseBranch)` — returns `{ additions, removals }` line counts from `git diff --numstat baseBranch...branch`. Local only, cheap.
- `pushBranch(projectDir, branch)` — `git push origin branch`. Throws on failure.
- `rebaseBranch(projectDir, branch, baseBranch)` — `git rebase baseBranch`. On conflict, delegates to the agent for resolution. On unrecoverable failure, runs `git rebase --abort` and throws.

### New route file: routes/git.ts

**`GET /api/projects/:id/git/spread?branch=feature/add-login&fetch=false`**

Returns the commit spread for a single branch. When `fetch=true`, the endpoint runs `fetchAll` + `pullBaseBranch` first and reconciles merged task statuses before querying. When `fetch=false` (or omitted), reads local refs only — instant. `getSpread` itself always reads local refs; the fetch is orchestrated by the route handler.

```json
{
  "branch": "feature/add-login",
  "aheadBase": 2,
  "behindBase": 0,
  "aheadRemote": 1,
  "behindRemote": 0
}
```

Remote fields are `null` if no remote tracking branch exists.

**`POST /api/projects/:id/git/push`**

Pushes a branch to origin.

Request: `{ "branch": "feature/add-login" }`
Response: `{ "ok": true }` or `{ "error": "..." }`

**`POST /api/projects/:id/git/rebase`**

Rebases a branch onto the base branch. The agent handles conflict resolution.

Request: `{ "branch": "feature/add-login" }`
Response: `{ "ok": true }` or `{ "error": "..." }`

### Enriched task list

**`GET /api/projects/:id/tasks`** response gains two optional fields per task:

- `diffStats: { additions: number, removals: number } | null` — line counts vs base branch. Only computed for open tasks with a branch. `null` for merged tasks.
- `status: "open" | "merged"` — task lifecycle status.

## Frontend

### diff-store.ts — owns all spread/sync state

- When the Changes tab is visible, polls `GET /git/spread?branch=...&fetch=true` on a ~60s cadence for the active branch
- Also polls `GET /git/spread?branch=...&fetch=false` more frequently for local-only numbers
- Exposes all four commit counts for the active branch
- Owns push/rebase actions (calls POST endpoints)
- Clears remote polling timers when the tab is hidden

### project-store.ts — unchanged polling, enriched data

- Existing task list fetches now include `diffStats` and `status` per task
- No new polling — diff stats are computed server-side in the task list response
- No spread/sync concerns here

### task-list.ts (sidebar)

- Renders branch name and `+N -N` below the task title for open tasks
- Merged tasks visually distinguished (dimmed, different icon, etc.)

### diff-panel.ts (Changes tab header)

- Shows commit spread numbers (ahead/behind base and remote) in the header bar
- Rebase button calls `POST /git/rebase`, shows loading spinner and success/error feedback
- Push button calls `POST /git/push`, shows loading spinner and success/error feedback

## Implementation order

1. ~~Backend: add `status` column to tasks table (migration)~~ ✅
2. ~~Backend: `getDiffStats`, `getSpread`, `pushBranch`, `rebaseBranch` in git.ts~~ ✅
3. ~~Backend: new `routes/git.ts` with spread/push/rebase endpoints~~ ✅
4. Backend: enrich task list response with `diffStats` and `status`; reconcile merged status during spread fetch
5. Frontend: update sidebar task items (branch name + diff stats + merged status)
6. Frontend: add spread polling + sync status + rebase/push buttons to Changes tab
