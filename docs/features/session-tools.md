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
| **search** | Discover Reins internal API functions for `execute` scripts against Reins-managed data or UI state. Returns documentation-only TypeScript interfaces filtered by query. | All sessions |
| **execute** | Run async JavaScript against Reins internals. The agent writes a function body with access to the existing `api` object. See [Scripting](scripting.md) for details. | All sessions |

Session orchestration uses `api.sessions.start`, `send`, and `wait` through **execute**. Starting returns a session ID without waiting for the response. Agents can create child or independent sessions, supply an optional title, and send messages that resume idle sessions or steer busy ones. Unsupported steering is reported; messages are not queued for later delivery. See [Scripting](scripting.md#start-message-and-wait-for-sessions).

## How They Appear in Chat

When the agent uses a tool, you'll see a compact inline block in the conversation. Each tool has its own visual style — file paths for read/edit/write, a terminal prompt for bash, colored cards for create_task and historical delegate calls.

Click on a tool block to expand it and see full details (file contents, command output, diff, etc.). Click again to collapse. Image results from the read tool show a compact preview inline without needing to expand the block.

## Tool execution

The registered [AgentHarness Pi runtime](runtimes.md) adapts coding tools (`read`, `write`, `edit`, and `bash`) and Reins application tools (`create_task`, `search`, and `execute`) into one harness tool set. Tool names and UI presentation remain consistent.
