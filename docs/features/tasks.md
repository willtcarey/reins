# Tasks

Tasks are the primary unit of work in Reins. Each task represents a discrete piece of work on a project — a bug fix, a feature, a refactor — and carries its own git branch and collection of agent sessions.

## Concepts

### Project → Tasks → Sessions

Reins organises work in a three-level hierarchy:

- A **project** points at a local git repository and tracks a base branch (e.g. `main`).
- A **task** belongs to a project. It has a title, an optional description, and a dedicated git branch.
- A **session** is a single agent conversation. Sessions belong to either the project's [assistant](assistant.md) or a task.

Task sessions inherit context from their parent task: the agent's system prompt includes the task title and description so the agent understands what it's working on without being told each time.

### Branch per task

Every task gets its own git branch, created when the task is created. This keeps work isolated — multiple tasks can be in flight without interfering with each other.

The branch is created **from the latest upstream state** of the project's base branch. When a remote (`origin`) is available, Reins pulls the local base branch forward to match before branching, so the task starts from the most up-to-date commit. For repos without a remote, or when the local branch has diverged, it branches from whatever the local base branch points to.

When a task session is opened, the task's branch is checked out automatically.

## Creating a task

Describe what you want to do in plain language — e.g. "add dark mode support" or "fix the login bug where sessions expire too early". Reins generates the task title, description, and branch name automatically from your input.

## Editing a task

You can view and edit a task's title and description after creation. Open the three-dot menu on a task in the sidebar and choose "Edit" to open the edit dialog. This is useful for refining the AI-generated title or description, or adding more detail as you learn more about the work.

The branch name is shown in the edit dialog for reference but cannot be changed.

## Working on a task

Once a task exists you can create sessions under it. Each session:

1. **Checks out the task branch** — this happens both when a new task session is created and when an existing one is resumed, so file changes always land on the right branch.
2. **Injects the task context** into the agent's system prompt (title + description).
3. Is recorded against the task so you can see the full history of sessions that contributed to a piece of work.

You can create as many sessions as you like per task. This is useful for breaking work into steps, trying different approaches, or resuming after reviewing changes.

## Deleting a task

Deleting a task removes:

- The task itself
- All sessions and their message history
- The task's git branch

A task cannot be deleted while any of its sessions are actively running. Stop the running session first, then delete.

## Lifecycle

Tasks are persistent — they survive server restarts. The `updated_at` timestamp is bumped whenever a new session is created under a task, keeping the most active tasks sorted to the top of the list.

### Closing tasks

Reins automatically detects when a task's work is done and marks it as **closed**. This happens during periodic remote sync (after fetching from origin and pulling the base branch) via two checks:

1. **Branch merged** — the task branch still exists but all its commits are reachable from the base branch. Reins closes the task and cleans up the local branch.
2. **Branch gone** — the task branch no longer exists locally or on the remote. This covers the common case where a branch is merged and deleted (via PR, CLI, etc.) before Reins gets a chance to observe it.

Once closed, a task stays closed permanently. Closed tasks no longer show diff stats (since their changes are now part of the base branch).
