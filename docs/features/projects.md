# Projects

A project ties together a **name**, a **workspace directory**, and a **base branch**. It's the top-level organizing concept — tasks and sessions all live under a project.

The **workspace directory** is the root path on disk where the project's code lives. When you start a session, this is the working directory the coding agent operates in.

The **base branch** (e.g. `main` or `develop`) is the branch that new task branches are created from. It represents the trunk of your project's development workflow.

## Assistant

Each project has an [assistant](assistant.md) — a long-lived conversation for managing the project, asking questions, and creating tasks.
