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

Generation runs on the project's node, using the [utility model](settings.md#utility-model), as a hidden session that is deleted as soon as it answers: it never appears in session lists. If the model can't produce a task within about 30 seconds (for example, the node is offline, the run fails or no model is configured), Reins creates the task anyway, using your text as the title and description and a branch name derived from it. You can edit the title and description afterwards.

### Adopting an existing branch

If you provide an explicit `branch_name` when creating a task and that branch already exists (locally or on origin), Reins **adopts** it instead of creating a new branch. The remote branch is fetched and checked out locally if needed, and the task's base commit is set to the merge-base of the project's base branch and the existing branch — so diffs and reconciliation work correctly even though the branch wasn't created by Reins.

This supports the "pull someone else's branch" workflow: a colleague pushes a branch, and you create a task pointing at it to get the full Reins experience (diff view, sessions, sync) on top of their work.

## Editing a task

You can view and edit a task's title and description after creation. Open the three-dot menu on a task in the sidebar and choose "Edit" to open the edit dialog. This is useful for refining the AI-generated title or description, or adding more detail as you learn more about the work.

The branch name is shown in the edit dialog for reference but cannot be changed.

## Working on a task

Once a task exists you can create sessions under it. Each session:

1. **Checks out the task branch** — this happens both when a new task session is created and when an existing one is resumed, so file changes always land on the right branch.
2. **Injects the task context** into the agent's system prompt (title + description). The task is read when the session's runtime opens, so an edited title or description reaches a session the next time it is opened (for example after a node restart), not mid-conversation.
3. Is recorded against the task so you can see the full history of sessions that contributed to a piece of work.

You can create as many sessions as you like per task. This is useful for breaking work into steps, trying different approaches, or resuming after reviewing changes. Long sessions open at their latest messages; scrolling to the top loads previous history while keeping the current reading position stable.

Sessions can be renamed, pinned, or archived from their action menu. Clearing a custom session name restores its first-message fallback. Pinned sessions appear before unpinned sessions, with both groups ordered by recent activity. Archived sessions retain their full history but are omitted from normal lists and appear in the project's full-screen History page, where they can be opened or unarchived. Pin and archive state are independent, never cascade between parent and child sessions, and are not changed implicitly when a session is opened or receives new activity.

## Deleting a task

Deleting a task removes:

- The task itself
- All sessions and their message history
- The task's git branch

A task cannot be deleted while any of its sessions are actively running. Stop the running session first, then delete.

## Delegation

Task sessions can **delegate** work using `api.sessions.start` through `execute`. A new session starts on the same task with a fresh context window and returns its session ID without waiting for its response. The parent can continue working, send messages that resume idle sessions or steer busy ones, and call `api.sessions.wait(sessionId)` to retrieve the latest result once all work in that session has settled. See [Scripting](scripting.md#start-message-and-wait-for-sessions).

Sub-sessions are hidden from the top-level task session list. Instead, top-level sessions that spawned sub-sessions show a **+N** badge. Clicking the badge opens a list of all their delegate descendants, including nested sub-sessions; clicking one navigates to it. A child conversation also shows a muted link to its immediate parent at the top of the conversation.

Finished sessions retain an amber unread indicator until their conversation is visibly viewed or they are explicitly marked read. The conversation counts as viewed only while the app is in the foreground and the Chat pane is on screen; activity completed while the Changes pane or another mobile page is active remains unread until Chat is shown. Idle task sessions and sub-sessions can be marked read or unread from their desktop context menu or by long-pressing them on mobile, and the active session has the same action in the main header menu. Explicitly marking the open session unread is preserved until the user leaves and views its conversation again. The sub-session popover also provides **Mark all as read** when one or more children have unread activity. Running sessions keep their running state and cannot be manually marked unread.

Creating a session requires an explicit parent choice: `parentSessionId: "current"` for a child, or `null` for an independent session. Optional titles use normal session names. Children are depth-limited (max 3 levels). Sessions run independently in the same checkout, so agents must coordinate file edits. Cancelling a parent or its wait does not cancel a child; children report their latest outcome when each run settles. Reports are saved with the child's settlement and delivered to the parent in order (starting an idle parent or steering a busy one), so they survive restarts; a rejected report is not retried. Reopening alone does not report, while subsequent work reports again.

## Starting work on creation

When creating a task (via the `create_task` tool), you can include a prompt to immediately kick off a session. The task is created and the session starts in the background — the tool returns right away. This lets a project assistant create a task and start work on it in one step.

## Lifecycle

Tasks are persistent — they survive server restarts. The `updated_at` timestamp is bumped whenever a new session (other than a background session) is created under a task, keeping the most active tasks sorted to the top of the list.

### Closing tasks

Tasks are closed explicitly (from the task's menu, or by the assistant's `tasks.close`). Reins does not close a task when its branch is merged: a project can have checkouts on several machines, and whether a branch looks merged or gone depends on which checkout looks. Refreshing the branch spread still fetches from origin and fast-forwards the base branch, in the checkout being viewed.

Once closed, a task stays closed permanently. Closed tasks leave the project sidebar and appear in the project's History page. They no longer show diff stats (since their changes are now part of the base branch). Closing a task quiets its sessions: their unread notifications are cleared, and a session still running when the task closes (such as the agent that closed it) finishes without becoming unread. A session you resume from History after the close notifies like any other, including the project and title badges.
