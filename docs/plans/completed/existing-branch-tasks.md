# Support Creating Tasks for Existing Branches

**Status:** In progress
**Date:** 2026-03-04
**Addresses TODO:** "Pulling someone else's branch for local work"

## Problem

Today, `create_task` always creates a new git branch from the base branch. There's no way to adopt an existing branch — e.g. a colleague's feature branch, or a branch created outside of Reins. Users want to pull someone else's branch and get the full task experience (diff view, sync controls, reconciliation).

## Design

### 1. Backend: `ProjectTasks.create()` changes

No new parameter needed. When `branch_name` is provided and the branch already exists (locally or on origin), adopt it automatically. The collision-suffix behavior is replaced:

- **Branch exists locally:** Skip `createBranch()`, use `mergeBase(baseBranch, branchName)` for `base_commit`.
- **Branch exists on origin only:** Fetch it, create a local tracking branch via `trackBranch()`, then use `mergeBase` as above.
- **Branch doesn't exist:** Create it from the base branch (current behavior), use `revParse(baseBranch)` for `base_commit`.
- **No `branch_name` provided:** Derive from title. If the derived name collides with an existing branch, append a suffix (current behavior) — auto-adopt only applies to explicitly provided names, since a random collision shouldn't silently adopt someone else's branch.

### 2. `create_task` tool: no changes needed

The existing `branch_name` parameter is sufficient. When it references an existing branch, adoption happens automatically. No new tool parameter required.

### 3. Remote branch handling

Fetching only happens when `branch_name` is explicitly provided and doesn't exist locally — the "pull someone else's branch" case. No fetch for derived names or locally-existing branches.

When the branch isn't local:

1. `fetchOrigin(projectDir, branchName)` — fetch that specific branch from origin.
2. Check `remoteBranchExists()` — confirm it arrived.
3. If found: create a local tracking branch via `trackBranch()`, then adopt.
4. If not found: create a new branch from the base (the branch simply doesn't exist anywhere yet).

This reuses existing git utilities. We add one new helper: `trackBranch(projectDir, branchName)` for step 3.

### 4. Upstream tracking / push behavior

No special tracking needed. The task stores `branch_name` and `base_commit` — that's sufficient. Push behavior is the same: `git push origin <branch>` works whether you created the branch or adopted it. If the branch has an upstream set, git handles it naturally.

We do NOT add an `adopted` flag to the task row. The task lifecycle is the same regardless of origin. If we later need to distinguish (e.g. "don't force-push adopted branches"), we can add it then.

### 5. Reconciliation: close-on-merge

The existing reconciliation logic in `ProjectModel.reconcileClosedTasks()` works correctly for adopted branches:

- **Merged detection:** `getMergedBranches()` checks if the branch tip is reachable from the base branch. This works regardless of who created the branch.
- **Never-diverged guard:** Compares `branch tip === base_commit`. With `merge-base`, the `base_commit` is the actual fork point, so a branch that has commits beyond its merge-base will correctly be detected as "has work" and eligible for close-on-merge.
- **Branch-deleted detection:** If both local and remote branches are gone, the task closes. Same behavior.

### 6. Error cases

No new error cases. The explicit `branch_name` path either adopts (exists) or creates (doesn't exist) — both are valid outcomes.

### 7. New git helper

```ts
export async function trackBranch(
  projectDir: string,
  branchName: string,
): Promise<void> {
  await runChecked(projectDir, ["branch", "--track", branchName, `origin/${branchName}`]);
}
```

### 8. New git helper: `mergeBase`

```ts
export async function mergeBase(
  projectDir: string,
  ref1: string,
  ref2: string,
): Promise<string> {
  const sha = await runChecked(projectDir, ["merge-base", ref1, ref2]);
  return sha.trim();
}
```

This also deduplicates the inline `git merge-base` calls in `getGitDiff()` and `getChangedFiles()`, which currently shell out manually.

## Implementation order

1. Add `mergeBase()` and `trackBranch()` to `git.ts`, refactor inline merge-base calls
2. Update `ProjectTasks.create()` — adopt when `branch_name` is explicit and exists
3. Write tests for the new path (local branch, remote-only branch, merge-base capture)
4. Update TODO to mark the item addressed
