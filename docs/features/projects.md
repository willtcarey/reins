# Projects

A project ties together a **name**, a **base branch**, and a **default source** (its default location). It's the top-level organizing concept — tasks and sessions live under a project.

Each session works in a **source**: a directory on a **node** (a machine), the working directory its coding agent operates in. The file browser, diffs and branch operations read the source of the session being viewed. A source belongs to no project: a session can work in any directory on any node, and two projects may use the same one. Reins keeps the list of sources, made the first time a session or a project uses a directory: a node has no list of its own, so a directory on any node, the local one or one you added ([nodes.md](nodes.md)), can be one.

The project's **default source** is the source it was created in: new sessions of the project work there, unless they have something better to follow (a task's sessions follow its most recent session; a child session its parent), and so do the task list's diff stats. The default source is only a default: on the new session page you can choose where the session works (one of the project's directories on any node, or any other directory), and you can move a session anywhere later.

When you add a project you give its name, base branch and default location: choose its node from a dropdown (nodes that are not connected are marked "(offline)"; a connected one is preselected) and its path there, an absolute path on that machine. A directory no session used yet is checked on that node: a path that is not a directory there, or a node that is not connected, refuses the project. A project created by the assistant's `projects.create` has its default source on the assistant's node unless it names another.

Editing a project shows the same fields, its default source's node and path filled in. Changing them moves its default source on **Save**, checked on that node the same way; a refusal shows in the form, which stays open. Moving the default source moves no session: each keeps the source it works in, until it is moved (below). From a terminal, `reins source list` lists the sources in use on each node with the projects using them. **Settings → Nodes** shows how many sources are in use on each node.

The **base branch** (e.g. `main` or `develop`) is the branch that new task branches are created from. It represents the trunk of your project's development workflow.

## Sidebar

All projects appear in the sidebar's **Projects** section ([sidebar.md](sidebar.md)) as collapsible rows, in name order. Clicking a project springs it open to show its assistant and tasks. Collapsing and reopening a project preserves its nested task disclosure state. The current project (the one of the session you look at) is expanded; opening a session in another project collapses the previous one unless you expanded it by hand ([sidebar.md](sidebar.md) *Projects*). A project's menu has **History**, **Pin** or **Unpin**, **Edit** and **Remove**.

```
▶ 📁 Acme API
▶ 📁 Dashboard
▼ 📁 Mobile App               ⋮
┃  💬 Assistant                ⋮
┃  TASKS                       +
┃  ▶ Refactor auth flow
▶ 📁 Shared Libs
▼ 📁 Web Frontend             ⋮
┃  💬 Assistant                ⋮
┃  TASKS                       +
┃  ▶ Add dark mode support
┃  ▶ Fix pagination bug
▶ 📁 Workers
[+ Add Project]
```

Each expanded project contains:

- **Assistant** — the project's conversations, with controls for starting another conversation. Pinned conversations stay above unpinned conversations while each group remains ordered by recent activity.
- **Tasks** — active tasks with their branch names and diff stats (read in the project's default source). The + button creates a new task. Expanding a task springs open its sessions, and loaded session rows refresh automatically as turns complete so first-message labels and message counts stay current. Completed tasks are kept out of the sidebar and appear in the project's History page.

**Other sessions.** Below the projects, a group of that name lists the sessions of no project that the browser shows, when there are any. Reins features such as extensions start sessions that have a source but no project (most of them hidden, as background sessions); the browser itself creates none. Clicking one opens it; its menu has no Move, rename, pin or archive.

Clicking a session navigates to it and sets that project as the active diff context. Session action menus are available by context menu on desktop and long-press on mobile. Sessions can be renamed; clearing a custom name restores the first-message fallback. Pinning and archiving are explicit, independent choices: archiving does not remove a pin, and neither state propagates to parent or child sessions. Archived sessions are hidden from normal project and task lists. "Move session…" in the action menu opens a dialog with a dropdown of every node (except removed ones; the session's own marked "current", nodes that are not connected "(offline)") and a path there: the paths where the project's sessions have worked on the chosen node are suggested, most recent first, and any other directory can be typed (a directory no session used yet is checked on the node). Another node where the project has worked is preselected with its latest path, and Move sends the session there; moving to another directory on the same node is a move too. The menu item shows the session's node as "Node: <name>", "Node: <name> (removed)" once that node was removed in Settings (the session then takes no new work until it is moved: [settings.md](settings.md) *Nodes*), and is disabled while the session is running. A move takes effect at once: the session's next prompt runs on the new node. A refused move (for example, pending work) is shown in the dialog.

## History

Choose **History** from a project's menu to open its full-screen History page. Separate **Completed tasks** and **Archived conversations** views keep the two kinds of history focused and searchable. Results use a compact responsive grid and load 20 items at a time, with additional pages available on demand.

Completed tasks expand to show all of their conversations, which can be reopened directly. The archived-conversation view includes task context where applicable; archived conversations can be reopened to read or unarchived from their action menu. Reopened sessions preserve their conversation, while completed-task sessions show the project's current filesystem and HEAD changes rather than reconstructing the deleted task branch. The URL is project-scoped, so History can be bookmarked and restored like a session route.

## File Upload

You upload files from the file browser of a session: the **Upload** button in its header opens a file picker (multiple selection supported), or you drop files on the browser. They are written into the folder of the file that is open (the checkout's root when none is), in that session's checkout on its node. The browser's tree shows them when the upload ends, and the session's Changes tab on its next refresh; a file appears only once it is written whole. A file of the same name is replaced.

Uploads have a 512 MB size limit. Filenames are sanitized to prevent path traversal.

## Assistant

Each project has an [assistant](assistant.md) — a long-lived conversation for managing the project, asking questions, and creating tasks.
