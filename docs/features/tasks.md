# Tasks

Tasks are the primary unit of work in Reins. Each task represents a discrete piece of work on a project — a bug fix, a feature, a refactor — and carries its own git branch and collection of agent sessions.

## Concepts

### Project → Tasks → Sessions

Reins organises work in a three-level hierarchy:

- A **project** points at a local git repository and tracks a base branch (e.g. `main`).
- A **task** belongs to a project. It has a title, an optional description, and a dedicated git branch.
- A **session** is a single agent conversation. Sessions can be standalone (project-level) or belong to a task.

Task sessions inherit context from their parent task: the agent's system prompt includes the task title and description so the agent understands what it's working on without being told each time.

### Branch per task

Every task gets its own git branch, created when the task is created. This keeps work isolated — multiple tasks can be in flight without interfering with each other.

The branch is created **from the latest upstream state** of the project's base branch. When a remote (`origin`) is available, Reins fetches and branches from `origin/<baseBranch>` so the task starts from the most up-to-date commit. For repos without a remote it falls back to the local base branch.

When a task session is opened, the task's branch is checked out automatically.

## Creating a task

When you create a task you provide:

| Field | Required | Notes |
|---|---|---|
| **Title** | Yes | Short summary of the work. |
| **Description** | No | Longer context — shown to the agent in every session. |
| **Branch name** | No | If left blank, a name is generated automatically in `task/<slug>` format. |

## Working on a task

Once a task exists you can create sessions under it. Each session:

1. **Checks out the task branch** — this happens both when a new task session is created and when an existing one is resumed, so file changes always land on the right branch.
2. **Injects the task context** into the agent's system prompt (title + description).
3. Is recorded against the task so you can see the full history of sessions that contributed to a piece of work.

You can create as many sessions as you like per task. This is useful for breaking work into steps, trying different approaches, or resuming after reviewing changes.

## Lifecycle

Tasks are persistent — they survive server restarts. The `updated_at` timestamp is bumped whenever a new session is created under a task, keeping the most active tasks sorted to the top of the list.

There is currently no formal "done" state for tasks. A task's branch can be merged through your normal git workflow (PR, merge, etc.) outside of Reins.
