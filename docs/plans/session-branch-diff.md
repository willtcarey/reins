# Plan: Show Session Diff from Base Branch

## Problem

The diff panel currently shows the diff of the **current working copy** — whatever branch is checked out plus uncommitted changes (`baseBranch...HEAD` + working tree). When a user selects a session in the sidebar, the diff doesn't necessarily reflect that session's work. If session A (on task branch `task/foo`) was the last to run, then viewing session B (on `task/bar`) still shows `task/foo`'s diff because that's what's checked out.

The diff should show the changes for the **selected session's branch** vs the project's base branch, regardless of what's currently checked out.

## Guiding Principle

**The user should never have to think about which git branch is checked out.** The app manages checkout state as an implementation detail. Every view — diff, sync controls, spread — is scoped to the session being viewed, not to HEAD. No UI element should behave differently based on checkout state in a way the user can observe.

## Current Architecture

### Backend (`packages/backend/src/git.ts` + `routes/diff.ts`)

- `getChangedFiles()` and `getDiff()` always diff against `baseBranch...HEAD` + uncommitted + untracked.
- The diff routes (`/diff/files`, `/diff`) take a `mode` query param (`branch` | `uncommitted`) but always use `HEAD` as the branch reference.
- No mechanism to diff a specific branch that isn't currently checked out.

### Frontend (`packages/frontend/src/changes/diff-store.ts`)

- `DiffStore` polls `/diff/files` and fetches `/diff` on demand.
- It has a `_projectId` but no concept of which session/branch it's displaying.
- The app shell (`app.ts`) wires the diff store to the project but never passes session/branch info.

### Session → Branch Relationship

- **Task sessions** have a `task_id` → task has a `branch_name`. This is the branch to diff.
- **Scratch sessions** have no task and no dedicated branch. They operate on whatever branch is checked out — typically the base branch, but could be someone else's branch pulled down for local work.

## Design

### Two Modes: Live Working Copy vs Committed Branch Snapshot

These are **backend implementation details** — the frontend doesn't know or care which mode is active. It just asks "show me this branch" and the backend returns the right data.

| Scenario | What to diff | Include uncommitted? |
|---|---|---|
| Scratch session (no task) | HEAD (whatever's checked out) | Yes — live working copy |
| Task session, branch is checked out | `baseBranch...taskBranch` | Yes — live working copy |
| Task session, branch is NOT checked out | `baseBranch...taskBranch` | No — committed only |

Scratch sessions always show the live HEAD diff. This preserves the workflow of checking out someone else's branch and making changes — the diff reflects what you're actually working on.

### Backend Changes

1. **Add `branch` query param to diff routes** (`routes/diff.ts`):
   - `/diff/files?branch=task/foo` — diff `baseBranch...task/foo`.
   - `/diff?branch=task/foo` — same for full diff.
   - When `branch` is provided, the backend compares it against the currently checked-out branch to decide whether to include uncommitted/untracked changes. The frontend doesn't need to know or care about checkout state.
   - When `branch` is omitted, keep current HEAD behavior (for scratch sessions).

2. **Update git helpers** (`git.ts`):
   - `getChangedFiles()` and `getDiff()` accept an optional `branch` parameter.
   - When branch matches HEAD: include committed + uncommitted + untracked (same as today).
   - When branch differs from HEAD: `git diff baseBranch...branch` (committed only). Later, also include stash contents (see Future section).
   - When branch is omitted: use HEAD as today.

3. **Spread endpoint** (`routes/git.ts`):
   - Already accepts a `branch` query param — no changes needed. The frontend just needs to pass the viewed session's branch.

4. **Push endpoint** (`routes/git.ts`):
   - Already accepts a `branch` body param. `git push origin <branch>` works without the branch being checked out. No changes needed.

5. **Rebase endpoint** (`routes/git.ts`):
   - Currently checks out the branch, rebases, and leaves it checked out. Update to **restore the previously checked-out branch** after the rebase completes. The user doesn't care about checkout state — rebase is an operation on a specific branch, not a request to switch to it.

### Frontend Changes

6. **`DiffStore` learns which branch to diff**:
   - Add a `setBranch(branch: string | null)` method.
   - When branch is set, include `?branch=...` on diff API calls, spread fetches, push, and rebase.
   - When branch is null, fall back to current HEAD behavior (scratch sessions).
   - The `diffMode` toggle ("all changes" vs "uncommitted") stays always visible. For a branch with no uncommitted changes, "uncommitted" mode simply shows an empty diff — no special-casing, no hiding. The UI behaves identically regardless of checkout state.

7. **App shell wires session → branch into DiffStore** (`app.ts`):
   - When a session is selected and it has a `task_id`, look up the task's `branch_name` from the task list in `ProjectStore`.
   - Call `diffStore.setBranch(branchName)`.
   - For scratch sessions (no `task_id`), call `diffStore.setBranch(null)`.

8. **Branch indicator shows the viewed branch** (`branch-indicator.ts`):
   - Currently shows the checked-out branch from `diffStore.fileData.branch`.
   - Update to show the viewed session's task branch instead. For scratch sessions (no task), continue showing the checked-out branch.
   - The app shell already passes `currentBranch` to the component — update the source to use the DiffStore's `branch` (the one being viewed) rather than `fileData.branch` (the one checked out).

9. **Sync controls operate on the viewed branch**:
   - The spread display, push button, and rebase button all operate on the viewed session's branch.
   - No special disabling needed — all sync operations work for any branch regardless of checkout state.

### Checkout State Is Invisible

The backend decides whether to include uncommitted changes by comparing the requested branch against HEAD internally. The frontend never asks "what's checked out?" — it just says "show me branch X" and the backend returns the right thing. This keeps the abstraction clean: the frontend is session-aware, the backend is git-aware. No frontend behavior or UI element changes based on which branch is checked out.

## Sequence of Changes

1. Backend: update `getChangedFiles()` and `getDiff()` in `git.ts` to accept optional `branch` param, with logic to include/exclude uncommitted based on whether it matches HEAD.
2. Backend: plumb the `branch` query param through `routes/diff.ts`.
3. Backend: update rebase to restore the previous branch after completing.
4. Frontend: add `setBranch()` to `DiffStore`, include param in all API calls (diff, spread, push, rebase).
5. Frontend: app shell resolves session → task → branch and calls `setBranch()` on session change.

## Edge Cases

- **Session's branch doesn't exist** (deleted, never pushed, etc.): the diff endpoints return empty. Show an appropriate empty state.
- **Scratch session on base branch**: HEAD is the base branch, `baseBranch...baseBranch` = empty diff. Correct.
- **No sessions exist yet**: diff store has no branch set, falls back to HEAD behavior.
- **User checks out a non-task branch manually**: scratch session shows that branch's diff against base. Correct — supports the "pull someone else's branch" workflow.

## Docs to Update

- **`docs/features/review.md`** — Reframe around the viewed session's branch rather than "the current branch." Update the diff modes and sync status sections to reflect that these operate on the selected session's branch, not HEAD.
- **`docs/TODO.md`** — Check off the task-specific diffs item. Leave the stash item open unless stash integration is included.

## Future: Stash Integration

Stash-on-switch is tracked as a separate TODO item. When implemented:

1. **Before switching away from a branch**: `git stash push -m "reins-auto:<branchName>"` if the working tree is dirty.
2. **After switching to a branch**: `git stash pop` if there's a matching `reins-auto:<branchName>` stash entry.
3. **Diff view for non-active branches**: use `git stash show -p` against the matching stash entry and merge it into the diff output alongside committed changes. Stashed changes appear as "uncommitted" so they're visible in the UI even when the branch isn't checked out.

The core branch-specific diff works without stashing — non-active branches simply show committed-only diffs until stash support is added.

Stashing also completes the diff mode story: without it, the "uncommitted" mode shows empty for non-checked-out branches (because their uncommitted changes were left on the working tree of whatever branch was checked out at the time). With stashing, every branch's uncommitted changes are preserved in its stash, so the "uncommitted" mode always shows the right thing regardless of checkout state. No UI workarounds needed.

## Out of Scope

- Stash push/pop on branch switch (follow-up, see TODO).
- Changing which branch is checked out when *viewing* a session (only *resuming/running* a session triggers checkout).
