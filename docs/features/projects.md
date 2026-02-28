# Projects

A project ties together a **name**, a **workspace directory**, and a **base branch**. It's the top-level organizing concept — tasks and sessions all live under a project.

The **workspace directory** is the root path on disk where the project's code lives. When you start a session, this is the working directory the coding agent operates in.

The **base branch** (e.g. `main` or `develop`) is the branch that new task branches are created from. It represents the trunk of your project's development workflow.

## Sidebar

All projects appear in the sidebar simultaneously as collapsible sections. Clicking a project expands it to show its assistant and tasks. Projects with active (running) sessions auto-expand.

```
▶ 📁 Acme API
▶ 📁 Dashboard
▼ 📁 Mobile App               ⋮
┃  💬 Assistant                ⋮
┃  TASKS                       +
┃  ▶ Refactor auth flow
┃  ▶ COMPLETED TASKS (3)
▶ 📁 Shared Libs
▼ 📁 Web Frontend             ⋮
┃  💬 Assistant                ⋮
┃  TASKS                       +
┃  ▶ Add dark mode support
┃  ▶ Fix pagination bug
┃  ▶ COMPLETED TASKS (12)
▶ 📁 Workers
[+ Add Project]
```

Each expanded project contains:

- **Assistant** — the project's long-lived conversation. The ⋮ menu provides access to previous conversations and creating a new one.
- **Tasks** — active tasks with their branch names and diff stats. The + button creates a new task. Expanding a task shows its sessions.
- **Completed tasks** — closed tasks, collapsed by default.

Clicking a session navigates to it and sets that project as the active diff context.

## Assistant

Each project has an [assistant](assistant.md) — a long-lived conversation for managing the project, asking questions, and creating tasks.
