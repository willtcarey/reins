# Delegate Tool

**Goal:** Let an agent spawn a sub-session with a fresh context window, do a unit of work, and return a summary — enabling work decomposition and context management.

## Context

Long tasks burn through context windows. Today the only option is to manually start a new session and re-explain the state of things. A `delegate` tool lets the agent itself split work into focused sub-sessions, keeping each one's context lean.

Two use cases:

1. **Task session → task session.** A session working on a task spawns a sub-session on the *same* task (same branch). The sub-session gets a fresh context window, does a scoped piece of work, and returns a summary. The parent continues with a small context footprint for that chunk.

2. **Scratch session → task session.** A scratch/orchestrator session creates tasks (via `create_task`) and then delegates work to each one. The sub-session checks out the task's branch, does the work, and returns. The scratch session never touches a branch itself — it stays in orchestrator mode.

## Design

### Tool definition: `delegate`

**Name:** `delegate`
**Description:** Start a sub-session to do a focused unit of work, then return the result. The sub-session gets a fresh context window and full access to coding tools. Use this to break large tasks into smaller pieces or to delegate work to a task from a scratch session.

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `task_id` | number | yes* | The task to work on. Required when calling from a scratch session. When calling from a task session, defaults to the current task. |
| `prompt` | string | yes | Instructions for the sub-session. Be specific — the sub-session has no prior context. |

\* Required from scratch sessions; optional from task sessions (defaults to current task).

**Behaviour:**

1. Resolve the target task. If `task_id` is provided, use it. If omitted, use the current session's task. Error if neither exists (scratch session without `task_id`).
2. Validate that the target task is the same as the current task, OR the current session is a scratch session. Cross-task delegation from a task session is not supported (branch checkout conflicts).
3. Create a new session on the target task via `createNewSession()` — this checks out the task branch and sets up the task system prompt.
4. Send the prompt to the sub-session via `session.prompt()` and await completion.
5. Extract the final assistant message from the sub-session's messages.
6. Return the final assistant text as the tool result.

**Tool result format:**

```ts
// Success
{
  content: [{ type: "text", text: finalAssistantMessage }],
  details: { sessionId: "...", messageCount: N }
}

// Error
{
  content: [{ type: "text", text: `Error: ${err.message}` }],
  details: null
}
```

### Threading state

The tool needs to create and run sub-sessions, but `ServerState` shouldn't leak into tools. Instead, follow the same pattern as `broadcast` — pass a narrowed closure:

```ts
type RunSubSession = (taskId: number, prompt: string) => Promise<{ sessionId: string; summary: string }>
```

This closure is built in `sessions.ts` (where `state` already lives) and captures `createNewSession`, `state`, `projectId`, `projectDir`, and `delegateDepth`. The tool factory receives it as a parameter alongside `projectId`, `broadcast`, and `currentTaskId`. The tool itself just calls `runSubSession(taskId, prompt)` — no knowledge of server internals.

### Multi-step plans: orchestrator loop

For plans with multiple steps, the orchestrating session calls `delegate` repeatedly — once per step. Each sub-session does its work and returns a summary. Depth is always 1 from the orchestrator's perspective. State handoff between steps happens via the file system (code changes, plan documents), not conversation history.

See [ADR-005](../adr/005-orchestrator-loop-not-relay-chain.md) for the reasoning behind this over a relay-chain model.

### Depth limiting

Sub-sessions get the delegate tool so they can split their own work, but recursion is depth-limited to prevent runaway nesting:

- The tool factory accepts a `delegateDepth` parameter (default 0).
- Each sub-session's tools are created with `delegateDepth + 1`.
- The tool refuses to execute when depth ≥ 3.

This is a recursion guard, not a chain limiter — sequential plan progression is the orchestrator's job, and each delegation is depth 1 from its perspective.

### Abort propagation

The tool's `execute` receives an `AbortSignal` from pi. If the parent session is aborted mid-delegation, the signal fires. The tool should call `subSession.abort()` and return an error result.

### Branch checkout coordination

- **Task → same task:** No branch change needed — already on the right branch.
- **Scratch → task:** The sub-session calls `createNewSession` with `taskId`, which checks out the task branch. When the sub-session completes, the working tree is left on the task branch. This is fine — the scratch session doesn't depend on any particular branch state.

### Parent tracking

Sub-sessions get a `parent_session_id` column in the sessions table (nullable FK to `sessions.id`). This gives us lineage tracking — you can trace a sub-session back to its parent, and query all sub-sessions spawned by a given session.

The `createNewSession` options grow to include `parentSessionId?: string`. The delegate tool passes its own session ID.

### Visibility

Sub-sessions are normal sessions in the DB, linked to the task, with a `parent_session_id` pointing at the session that spawned them. They appear in the task's session list in the UI with a visual indicator that they're delegated (e.g. an indent or badge). Events broadcast over WS as usual, so the user sees the sub-session's work in real time.

### What the sub-session sees

The sub-session is a regular task session: it gets the task system prompt ("You are working on this task"), the project's AGENTS.md context, and full coding tools. It has no knowledge of the parent session. The prompt should be self-contained.

## Implementation

### File changes

#### 1. New file: `packages/backend/src/tools/delegate.ts`

Tool factory module. Contains:

- `createDelegateTool(state, projectId, currentTaskId, broadcast, depth)` — returns a `ToolDefinition`
- `execute` creates a sub-session, prompts it, awaits completion, returns summary

The tricky part is awaiting completion. `session.prompt()` returns a promise that resolves when the agent finishes its turn (including all tool calls). That's exactly what we need.

```ts
const managed = await createNewSession(state, projectId, projectDir, { taskId: targetTaskId });
await managed.session.prompt(params.prompt);

// Extract final assistant message
const messages = managed.session.messages;
const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
const summary = extractText(lastAssistant);
```

#### 2. `packages/backend/src/tools/index.ts`

- Import `createDelegateTool`
- Add `currentTaskId`, `delegateDepth`, and `runSubSession` parameters to `createCustomTools`
- Include the delegate tool in the returned array

#### 3. New migration: `012_add_parent_session_id`

```sql
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
```

`ON DELETE SET NULL` so that if a parent session is ever cleaned up, the sub-session doesn't vanish — it just loses its lineage link.

#### 4. `packages/backend/src/session-store.ts`

- Add `parent_session_id` to `SessionRow` and `SessionListItem`.
- Update `createSession` to accept and insert `parentSessionId`.
- Update list queries to include `parent_session_id` so the frontend can identify sub-sessions.

#### 5. `packages/backend/src/sessions.ts`

- Build a `RunSubSession` closure in `buildSessionOpts` that captures `state`, `projectId`, `projectDir`, and `delegateDepth`. The closure calls `createNewSession` with the incremented depth and parent session ID, prompts the sub-session, extracts the summary, and returns it.
- Pass the closure (along with `currentTaskId` and `delegateDepth`) through to `createCustomTools`.
- `createNewSession` accepts new options: `delegateDepth?: number`, `parentSessionId?: string`.

#### 6. Frontend: session list display

Sub-sessions (those with a `parent_session_id`) get a visual indicator in the task's session list — a subtle badge or label. The full session is viewable by clicking in like any other session. No structural changes to the session view itself.

### What we're NOT doing

- **Cross-task delegation from task sessions.** Would require branch checkout coordination. Out of scope.
- **Parallel delegation.** Single working tree means sequential only.
- **Custom sub-session model/thinking level.** Sub-sessions inherit the server's model config. Could be added later.
- **Streaming sub-session output to parent.** The parent just gets the final summary. The user sees real-time output via WS broadcast, but the parent agent doesn't.

## Open questions

1. **Should the parent session's branch be restored after a scratch → task delegation?** Currently it won't be, since `createNewSession` checks out the task branch. The scratch session doesn't care, but if the user was looking at files before delegating, the working tree has changed. Probably fine — scratch sessions are orchestration-mode, not file-editing-mode.

2. **What if the sub-session hits an error or gets stuck in a loop?** The depth limit prevents infinite recursion. For stuck sessions, the abort signal propagation handles user-initiated cancellation. We could add a turn limit or token budget later.

3. **Should the tool accept an optional `context` parameter for injecting extra files/docs into the sub-session?** Not for v1 — the prompt can tell the sub-agent to read specific files. Task-pinned documents (a separate TODO item) would solve this more broadly.
