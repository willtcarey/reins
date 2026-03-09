# Review

The Changes tab lets you review the work an agent has done. It shows a syntax-highlighted diff alongside a navigable file tree sidebar. The diff always reflects the **selected session's branch** — not whatever branch happens to be checked out.

When viewing a task session, the diff shows changes on the task's branch compared to the base branch. When viewing a scratch session (no task), the diff shows the live working copy.

## Diff modes

The file tree sidebar includes a dropdown at the top for switching between two diff modes:

### Branch changes (default)

Shows **all changes** on the selected session's branch compared to the base branch. This includes both committed and uncommitted work — the full picture of what the task branch has changed.

### Uncommitted changes

Shows **only uncommitted working-tree changes** — edits that haven't been committed yet. Useful when a task has accumulated many commits and you want to see just what's been modified since the last commit.

## Hunk expansion

Each diff shows a few lines of context around changes by default. You can expand to see more of the surrounding file:

- **Above a hunk** — a button appears if there are hidden lines above the first visible line. Click to reveal more context upward.
- **Below a hunk** — a button at the bottom of the last hunk reveals more lines below.
- **Between hunks** — when two hunks are separated by hidden lines, a button shows how many lines are hidden. If the gap is small (≤ 15 lines), one click reveals them all. For larger gaps, it reveals 15 lines at a time.

When expanding closes the gap between two adjacent hunks, they automatically merge into a single hunk. Expanded lines are fetched from the full file on demand (not included in the initial diff payload) and syntax-highlighted in the background.

## Markdown files

Markdown files (`.md`, `.mdx`, `.markdown`) get two view modes toggled via tabs above the diff:

- **Diff** (default) — the normal syntax-highlighted diff with word wrapping enabled
- **Preview** — the rendered markdown content of the current file version

## Sync status

The diff header shows how the selected session's branch relates to the base branch and the remote.

Next to the **base branch name**:

- **N ahead** — the base branch has moved ahead since the task branched. A **Rebase** button appears to rebase the task branch onto the latest base branch.

Next to the **task branch name**:

- **N ahead** — commits on the task branch since it diverged from the base branch.
- **N unpushed** — commits that haven't been pushed to origin. A **Push** button appears to push them. The Push button also appears when the branch has never been pushed.
- **N behind origin** — someone else has pushed to this branch on the remote (rare in single-developer workflows).

Remote-aware numbers (unpushed, behind origin) are refreshed periodically in the background via `git fetch`. Local numbers update more frequently since they only read local refs.
