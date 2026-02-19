# Review

The Changes tab lets you review the work an agent has done. It shows a syntax-highlighted diff alongside a navigable file tree sidebar.

## Diff modes

The file tree sidebar includes a dropdown at the top for switching between two diff modes:

### Branch changes (default)

Shows **all changes** on the current branch compared to the base branch. This includes both committed and uncommitted work — the full picture of what the task branch has changed.

### Uncommitted changes

Shows **only uncommitted working-tree changes** — edits that haven't been committed yet. Useful when a task has accumulated many commits and you want to see just what's been modified since the last commit.

## Sync status

The diff header shows how the current branch relates to the base branch and the remote.

Next to the **base branch name**:

- **N ahead** — the base branch has moved ahead since the task branched. A **Rebase** button appears to rebase the task branch onto the latest base branch.

Next to the **task branch name**:

- **N ahead** — commits on the task branch since it diverged from the base branch.
- **N unpushed** — commits that haven't been pushed to origin. A **Push** button appears to push them. The Push button also appears when the branch has never been pushed.
- **N behind origin** — someone else has pushed to this branch on the remote (rare in single-developer workflows).

Remote-aware numbers (unpushed, behind origin) are refreshed periodically in the background via `git fetch`. Local numbers update more frequently since they only read local refs.
