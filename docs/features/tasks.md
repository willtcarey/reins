# Tasks

Tasks are the primary unit of work in Reins. Each task represents a discrete piece of work on a project — a bug fix, a feature, a refactor, a document — and carries its collection of agent sessions, and a git branch of its own when you asked for one.

## Concepts

### Project → Tasks → Sessions

Reins organises work in a three-level hierarchy:

- A **project** points at a local git repository and tracks a base branch (e.g. `main`).
- A **task** belongs to a project. It has a title, an optional description, and, when you ask for one at its creation (*Branches*, below), a git branch of its own.
- A **session** is a single agent conversation. Sessions belong to either the project's [assistant](assistant.md) or a task.

Task sessions inherit context from their parent task: the agent's system prompt includes the task title and description so the agent understands what it's working on without being told each time.

### Where a task starts

A task remembers where it started: at the first run of one of its sessions, Reins records the branch the session's checkout is on and its commit. What the task changed is measured from that commit: Changes shows the checkout's changes since then, and the sidebar counts them. Reins itself never switches a checkout's branch.

### Branches

A task has a git branch of its own **only when you ask for one when you create it**. Then, before each run of one of its sessions, Reins puts the session's checkout on the task's branch. It keeps work isolated: tasks in flight in different checkouts do not interfere with each other. A task without a branch of its own runs on whatever its checkout has checked out: two such tasks can share one checkout and one branch. Use that for tasks that are not code, or when you manage branches yourself.

If the checkout does not have the task's branch yet, it is made there: from `origin` if someone pushed it (from another machine, for example), else new from the latest upstream state of the project's base branch (when a remote is available, the local base branch is pulled forward first; for repos without a remote, or when the local branch has diverged, it branches from the local base branch). So a task session moved to another node or directory gets the branch there too. Changes then compares the branch with the base branch.

Creating a task touches no checkout. A branch name made from the title that another task of the project has gets a short suffix. Tasks made before branches became optional keep their branches.

**Closed tasks** are left alone: their sessions run on whatever is checked out, and a branch deleted after the task closed is not made again.

**A deleted branch is not made again.** If an open task's branch existed and was deleted (here and on origin), its next run is refused: "This task's branch, task/x, was deleted. Make it again, or close the task." Make the branch again (or push it from where it is), or close the task. The same message appears when a task's session moves to a checkout that never had its branch and the branch was not pushed.

## Creating a task

Describe what you want to do in plain language — e.g. "add dark mode support" or "fix the login bug where sessions expire too early". Reins generates the task title and description automatically from your input. Tick **Work on a branch of its own** to give the task a branch (Reins names it from your input too); leave it unticked for a task whose sessions work on whatever is checked out. Agents creating a task (`create_task`, `reins.tasks.create`) give it a branch by naming one.

Generation runs on the server, using the [utility model](settings.md#utility-model), as a hidden session that is deleted as soon as it answers: it never appears in session lists, and it needs no node. If the model can't produce a task within about 30 seconds (for example, the run fails or no model is configured), Reins creates the task anyway, using your text as the title and description (and, if you asked for a branch, a branch name derived from it). You can edit the title and description afterwards.

### Adopting an existing branch

If you provide an explicit `branch_name` when creating a task and that branch already exists (locally or on origin) where its session works, Reins **adopts** it instead of creating a new branch. A branch name made from the title that happens to match an existing branch there is adopted the same way. The remote branch is fetched and checked out locally if needed, and the task's base commit is set to the merge-base of the project's base branch and the existing branch — so diffs and reconciliation work correctly even though the branch wasn't created by Reins.

This supports the "pull someone else's branch" workflow: a colleague pushes a branch, and you create a task pointing at it to get the full Reins experience (diff view, sessions, sync) on top of their work.

## Editing a task

You can view and edit a task's title and description after creation. Open the three-dot menu on a task in the sidebar and choose "Edit" to open the edit dialog. This is useful for refining the AI-generated title or description, or adding more detail as you learn more about the work.

The task's branch, once it has one, is shown in the edit dialog for reference but cannot be changed.

## Working on a task

Once a task exists you can create sessions under it, from its **New session** button. Each session:

1. **Works on the task's branch**, when the task has one: it is checked out in the session's source on its node at the start of each run (made there first if that checkout does not have it), so file changes land on the right branch. Otherwise it works on whatever is checked out.
2. **Injects the task context** into the agent's system prompt (title + description). The task is read when the session's runtime opens, so an edited title or description reaches a session the next time it is opened (after it has been idle for a few minutes, or after a server restart), not mid-conversation.
3. Is recorded against the task so you can see the full history of sessions that contributed to a piece of work.

You can create as many sessions as you like per task. This is useful for breaking work into steps, trying different approaches, or resuming after reviewing changes. Long sessions open at their latest messages; scrolling to the top loads previous history while keeping the current reading position stable.

Sessions can be renamed, pinned, or archived from their action menu. Clearing a custom session name restores its first-message fallback. Pinned sessions appear before unpinned sessions, with both groups ordered by recent activity. Archived sessions retain their full history but are omitted from normal lists and appear in the project's full-screen History page, where they can be opened or unarchived. Pin and archive state are independent, never cascade between parent and child sessions, and are not changed implicitly when a session is opened or receives new activity.

## Deleting a task

Deleting a task removes:

- The task itself
- All sessions and their message history
- The task's git branch, if it has one of its own

A task cannot be deleted while any of its sessions are actively running. Stop the running session first, then delete.

## Delegation

Task sessions can **delegate** work using `reins.sessions.start` through `execute`. A new session starts on the same task with a fresh context window and returns its session ID without waiting for its response. The parent can continue working, send messages that resume idle sessions or steer busy ones, and call `reins.sessions.wait(sessionId)` to retrieve the latest result once all work in that session has settled. See [Scripting](scripting.md#start-message-and-wait-for-sessions).

Sub-sessions are hidden from the top-level task session list. Instead, top-level sessions that spawned sub-sessions show a **+N** badge. Clicking the badge opens a list of all their delegate descendants, including nested sub-sessions; clicking one navigates to it. A child conversation also shows a muted link to its immediate parent at the top of the conversation.

Finished sessions retain an amber unread indicator until their conversation is visibly viewed or they are explicitly marked read. The conversation counts as viewed only while the app is in the foreground and the Chat pane is on screen; activity completed while the Changes pane or another mobile page is active remains unread until Chat is shown. Idle task sessions and sub-sessions can be marked read or unread from their desktop context menu or by long-pressing them on mobile, and the active session has the same action in the main header menu. Explicitly marking the open session unread is preserved until the user leaves and views its conversation again. The sub-session popover also provides **Mark all as read** when one or more children have unread activity. Running sessions keep their running state and cannot be manually marked unread.

Creating a session requires an explicit parent choice: `parentSessionId: "current"` for a child, or `null` for an independent session. Optional titles use normal session names. Children are depth-limited (max 3 levels). Sessions run independently in the same checkout, so agents must coordinate file edits. Cancelling a parent or its wait does not cancel a child; children report their latest outcome when each run settles. Reports are saved with the child's settlement and delivered to the parent in order (starting an idle parent or steering a busy one), so they survive restarts; a rejected report is not retried. Reopening alone does not report, while subsequent work reports again.

## Starting work on creation

When creating a task (via the `create_task` tool), you can include a prompt to immediately kick off a session. The task is created and the session starts in the background — the tool returns right away. This lets a project assistant create a task and start work on it in one step.

## Lifecycle

Tasks are persistent — they survive server restarts. The `updated_at` timestamp is bumped whenever a new session (other than a background session) is created under a task, keeping the most active tasks sorted to the top of the list.

### Closing tasks

Tasks are closed explicitly (from the task's menu, or by the assistant's `tasks.close`). Reins does not close a task when its branch is merged: a project's sessions can work in several directories on several machines, and whether a branch looks merged or gone depends on which one looks. Refreshing the branch spread still fetches from origin and fast-forwards the base branch, in the source being viewed.

Once closed, a task stays closed permanently. Closed tasks leave the project sidebar and appear in the project's History page. They no longer show diff stats (since their changes are now part of the base branch). Closing a task quiets its sessions: their unread notifications are cleared, and a session still running when the task closes (such as the agent that closed it) finishes without becoming unread. A session you resume from History after the close notifies like any other, including the project and title badges.
