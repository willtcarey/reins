# Agent Task Creation Tool

**Goal:** Let the agent create new tasks from within a conversation, so a user can say "create a task for this" without leaving the current session.

## Context

Today, tasks are created via the REST API (`POST /api/projects/:id/tasks/generate`), triggered from the frontend UI. The agent has no way to create tasks itself. The TODO item calls for exposing a tool so the agent can do this from any session — scratch sessions or existing task sessions — when work surfaces that should be tracked separately.

There is also a `POST /api/projects/:id/tasks` route for creating tasks with explicit title/description/branch, but it is unused by the frontend and will be removed as part of this work.

## Design

### Custom tool via pi SDK `customTools`

The pi SDK supports a `customTools` option on `createAgentSession()`. We pass a `ToolDefinition` array that gets merged with the standard coding tools. This is the right mechanism — no extensions needed, and the tools are defined in our backend code where they have access to our stores and git helpers.

### Tool definition: `create_task`

**Name:** `create_task`
**Description:** Create a new task for the current project with a dedicated git branch. Only use this when the user explicitly asks you to create a task — do not proactively create tasks.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Concise task title (imperative mood, e.g. "Add dark mode support") |
| `description` | string | yes | Brief description with actionable detail (1-3 sentences) |
| `branch_name` | string | no | Git branch name in `task/<slug>` format. If omitted, derived from the title. |

The calling agent already has full conversation context, so it fills in the title and description directly — no second LLM call needed. This avoids the latency and redundancy of routing through `generateTask()`.

**Behaviour:**
1. Derive `branch_name` from title via `slugifyBranchName()` if not provided.
2. Check for branch collision; append suffix if needed (same logic as the `/tasks/generate` route).
3. Create the git branch from the project's base branch via `createBranch()`.
4. Insert the task row via `createTask()` from `task-store.ts`.
5. Broadcast a `task_created` event over WebSocket so the frontend sidebar updates in real time.
6. Return the created task (id, title, description, branch_name, status) as the tool result.

**Tool result format:** The `execute` function must return `AgentToolResult` (from `@mariozechner/pi-agent-core`), which has the shape `{ content: (TextContent | ImageContent)[], details: T }`. On success, return a single `TextContent` entry with the created task serialized as JSON, and `details` as the raw `TaskRow` object. On error, return the error message as `TextContent` with `details: null`.

```ts
// Success
{ content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: task }

// Error
{ content: [{ type: "text", text: `Error: ${err.message}` }], details: null }
```

The `execute` function signature must match `ToolDefinition.execute`: `(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) => Promise<AgentToolResult>`. The tool doesn't need `signal`, `onUpdate`, or `ctx` — it just ignores them.

### Extracting project context

The tool needs to know the `projectId` and `projectDir` for the session it's running in. Since `createAgentSession` doesn't carry this context, we'll use a **closure**: the tool factory receives `projectId` and `projectDir` at session-creation time and closes over them.

### WebSocket broadcast for sidebar updates

When a task is created — whether by the tool or `POST /tasks/generate` — the frontend sidebar needs to know. We'll broadcast a lightweight event (`{ type: "task_created", projectId, task }`) to all WS clients. The frontend listens for this and refreshes its task list.

This broadcast lives in `createTaskWithBranch()` itself, so every creation path gets it automatically. The function takes `ServerState` (or just the clients set) so it can broadcast.

## Implementation

### File changes

#### 1. New model layer: `packages/backend/src/models/`

Introduce a `models/` directory as a business-logic layer between routes/tools and the low-level stores (`*-store.ts`) and utilities (`git.ts`, `branch-namer.ts`). Models orchestrate store calls, git operations, validation, and WS broadcasts. Stores stay as thin DB access. Routes become thin HTTP adapters.

We start with **`models/tasks.ts`** for this feature, but the pattern extends naturally — `models/projects.ts`, `models/sessions.ts`, etc. can be extracted later as we touch those areas.

**`packages/backend/src/models/tasks.ts`:**

```ts
export async function createTaskWithBranch(
  projectId: number,
  projectDir: string,
  baseBranch: string,
  params: { title: string; description: string; branch_name?: string },
  clients: Set<WsClient>,
): Promise<TaskRow>
```

This function:
1. Derives `branch_name` from title via `slugifyBranchName()` if not provided.
2. Checks for branch collision; appends a suffix if needed.
3. Creates the git branch from `baseBranch`.
4. Inserts the task row via `createTask()`.
5. Broadcasts `{ type: "task_created", projectId, task }` to all WS clients.
6. Returns the created `TaskRow`.

Throws on failure (branch creation errors, etc.) — callers handle errors in their own way (HTTP response vs tool error result).

Over time, other task operations (delete with branch cleanup, close, etc.) migrate here too — but that's not in scope for this change.

#### 2. `packages/backend/src/routes/tasks.ts`

- **Remove** the `POST /tasks` route (unused by the frontend — only `POST /tasks/generate` is called).
- Refactor `POST /tasks/generate` to call `createTaskWithBranch()` instead of inlining the branch-check/create/insert sequence. The route still calls `generateTask()` first to get the LLM-generated params (including its LLM-generated `branch_name`), then passes them to the model function.

#### 3. New file: `packages/backend/src/tools/create-task.ts`

Custom tool factory module. Contains:

- `createTaskTool(projectId, projectDir, baseBranch, state)` — returns a `ToolDefinition`
- The `execute` function calls `createTaskWithBranch()` (which handles the WS broadcast)
- Uses `@sinclair/typebox` for parameter schema (already a transitive dep via pi SDK)

Putting this in a `tools/` subdirectory sets up a clean pattern for future custom tools.

#### 4. `packages/backend/src/tools/index.ts`

Barrel export for all custom tools. Exports a `createCustomTools(projectId, projectDir, baseBranch, state)` function that returns the full `ToolDefinition[]` array. This is the single entry point that `sessions.ts` calls — when we add more tools later, they just get added here.

#### 5. `packages/backend/src/sessions.ts`

In `buildSessionOpts()`:
- Import `createCustomTools` from `./tools/index.js`
- Accept `projectId`, `state`, and `baseBranch` as additional parameters (already has `projectDir`)
- Pass `customTools: createCustomTools(projectId, projectDir, baseBranch, state)` into the return object

Update callers of `buildSessionOpts()` (`createNewSession` and `resumeSession`) to pass the new args. Both already have access to `state` and `projectId`; `baseBranch` comes from the project row via `getProject()`. Note: `resumeSession` currently doesn't receive `projectId` — it gets it from the session's DB row (`row.project_id`), then looks up the project to get `baseBranch`.

#### 6. `packages/frontend/src/` — WS event handling

Add a handler for the `task_created` event type in the frontend's WebSocket message handler. When received, refresh the task list for the relevant project so the sidebar updates without manual reload.

### What we're NOT doing

- **No task editing/deletion tool** — keep scope narrow; the user can manage tasks from the UI.
- **No session creation under the new task** — the tool just creates the task. The user decides when to start working on it.

## Testing

Manual testing:
1. Open a scratch session, ask the agent to "create a task for adding dark mode support"
2. Verify the task appears in the sidebar in real time
3. Verify the task has a proper title, description, and branch
4. Verify the git branch exists and is based on the project's base branch
5. Open a task session, ask the agent to create a different task — verify it works from task sessions too
6. Test error case: try to create a task when git operations would fail

## Future considerations

- The `tools/` directory pattern supports adding more tools (e.g., `list-tasks`, `update-task`) later.
- If we add the project assistant session (another TODO item), the task creation tool will be naturally available there.
