# Projects

A project ties together a **name**, a **workspace directory**, and a **base branch**. It's the top-level organizing concept — tasks and sessions all live under a project.

The **workspace directory** is the root path on disk where the project's code lives. When you start a session, this is the working directory the coding agent operates in.

The **base branch** (e.g. `main` or `develop`) is the branch that new task branches are created from. It represents the trunk of your project's development workflow.

## Sidebar

All projects appear in the sidebar simultaneously as collapsible sections. Clicking a project springs it open to show its assistant and tasks. Collapsing and reopening a project preserves its nested task disclosure state. Projects with active (running) sessions auto-expand.

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
- **Tasks** — active tasks with their branch names and diff stats. The + button creates a new task. Expanding a task springs open its sessions, and loaded session rows refresh automatically as turns complete so first-message labels and message counts stay current. Completed tasks are kept out of the sidebar and appear in the project's History page.

Clicking a session navigates to it and sets that project as the active diff context. Session action menus are available by context menu on desktop and long-press on mobile. Sessions can be renamed; clearing a custom name restores the first-message fallback. Pinning and archiving are explicit, independent choices: archiving does not remove a pin, and neither state propagates to parent or child sessions. Archived sessions are hidden from normal project and task lists.

## History

Choose **History** from a project's menu to open its full-screen History page. Separate **Completed tasks** and **Archived conversations** views keep the two kinds of history focused and searchable. Results use a compact responsive grid and load 20 items at a time, with additional pages available on demand.

Completed tasks expand to show all of their conversations, which can be reopened directly. The archived-conversation view includes task context where applicable; archived conversations can be reopened to read or unarchived from their action menu. Reopened sessions preserve their conversation, while completed-task sessions show the project's current filesystem and HEAD changes rather than reconstructing the deleted task branch. The URL is project-scoped, so History can be bookmarked and restored like a session route.

## File Upload

You can upload files directly to a project's workspace directory from the sidebar. Open the **⋮** menu on a project and select **Upload files** to open a file picker (multiple selection supported). Files are written to the project root and appear in the Changes tab immediately.

The upload endpoint supports an optional subdirectory parameter and has a 512 MB size limit. Filenames are sanitized to prevent path traversal.

## Assistant

Each project has an [assistant](assistant.md) — a long-lived conversation for managing the project, asking questions, and creating tasks.
