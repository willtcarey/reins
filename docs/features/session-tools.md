# Session Tools

Every agent session has access to a set of tools for reading, modifying, and navigating your codebase. These are the actions the agent can take on your behalf during a conversation.

## Coding Tools

Available in every session:

| Tool | What it does |
|------|-------------|
| **read** | Read file contents. Supports text files and images. For large files, the agent can read specific line ranges using offset/limit. |
| **bash** | Execute a shell command in the project's working directory. Used for running tests, installing packages, searching with grep/find, and anything else you'd do in a terminal. |
| **edit** | Make surgical edits to a file by finding exact text and replacing it. The agent uses this for precise, targeted changes. |
| **write** | Create or overwrite a file. Used for new files or complete rewrites. Automatically creates parent directories. |

## App Tools

These tools let the agent interact with Reins itself:

| Tool | What it does | Availability |
|------|-------------|-------------|
| **create_task** | Create a new task with a title, description, and git branch. Can optionally kick off an initial session on the task immediately — the task is created and work begins in the background. | All sessions |
| **delegate** | Spawn a sub-session on the current task with a fresh context window. The agent can break large work into focused sub-sessions, keeping each one's context lean. The sub-session runs to completion and returns its result. Delegation can also override the sub-session's model and thinking level when needed. | Task sessions only |
| **search** | Discover available API functions for the `execute` tool. Returns function signatures and type definitions filtered by query. | All sessions |
| **execute** | Run async JavaScript against Reins internals. The agent writes a function body with access to an `api` object (tasks, sessions, projects). See [Scripting](scripting.md) for details. | All sessions |

## How They Appear in Chat

When the agent uses a tool, you'll see a compact inline block in the conversation. Each tool has its own visual style — file paths for read/edit/write, a terminal prompt for bash, colored cards for create_task and delegate.

Click on a tool block to expand it and see full details (file contents, command output, diff, etc.). Click again to collapse.
