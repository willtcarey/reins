# Delegate Tool

**Goal:** Let an agent spawn a sub-session with a fresh context window, do a unit of work, and return a summary — enabling work decomposition and context management.

## Context

Long tasks burn through context windows. Today the only option is to manually start a new session and re-explain the state of things. A `delegate` tool lets the agent itself split work into focused sub-sessions, keeping each one's context lean.

The use case is **task session → task session**: a session working on a task spawns a sub-session on the *same* task (same branch). The sub-session gets a fresh context window, does a scoped piece of work, and returns a summary. The parent continues with a small context footprint for that chunk.

Separately, the `create_task` tool gains an optional `prompt` parameter to kick off an initial session on a newly created task (fire-and-forget). That covers the "start work on a task from scratch" use case without needing delegation.

## Design

### Tool definition: `delegate`

**Name:** `delegate`
**Description:** Start a sub-session to do a focused unit of work, then return the result. The sub-session gets a fresh context window and full access to coding tools. Use this to break large tasks into smaller pieces, keeping each sub-session's context lean.

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | Instructions for the sub-session. Be specific — the sub-session has no prior context. |

The tool is only available in task sessions. It always delegates to the current task.

**Behaviour:**

1. Error if the current session is not a task session (no task ID).
2. Create a new session on the current task via `createNewSession()` — already on the right branch, sets up the task system prompt.
3. Prepend the autonomy preamble to the prompt and send it to the sub-session via `session.prompt()`. Await completion.
4. Extract the final assistant message from the sub-session's messages.
5. Remove the sub-session from `state.sessions` (already persisted to SQLite).
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

The delegate tool is stateless at definition time. Its factory signature is:

```ts
createDelegateTool(state: ServerState, sessionId: string, createSession: CreateSessionFn)
```

- **`state`** and **`sessionId`** are stable references passed at factory time (session creation).
- At execution time, the tool looks up everything it needs from the DB: the session row gives `project_id` and `task_id`, the project row gives the working directory, and delegation depth is derived by walking the `parent_session_id` chain.
- **`createSession`** is a function injected to avoid circular imports (`sessions.ts` → `tools/index.ts` → `delegate.ts` → `sessions.ts`). It wraps `createNewSession` from `sessions.ts`.

Session IDs are generated upfront via `crypto.randomUUID()` before calling `createAgentSession`, so they can be passed to tool factories before the pi session exists. This replaces the earlier `sessionIdRef` mutable-ref hack.

### Multi-step plans: orchestrator loop

For plans with multiple steps, the orchestrating session calls `delegate` repeatedly — once per step. Each sub-session does its work and returns a summary. Depth is always 1 from the orchestrator's perspective. State handoff between steps happens via the file system (code changes, plan documents), not conversation history.

See [ADR-005](../adr/005-orchestrator-loop-not-relay-chain.md) for the reasoning behind this over a relay-chain model.

### Depth limiting

Sub-sessions get the delegate tool so they can split their own work, but recursion is depth-limited to prevent runaway nesting:

- The tool factory accepts a `delegateDepth` parameter (default 0).
- Each sub-session's tools are created with `delegateDepth + 1`.
- The tool refuses to execute when depth ≥ 3.

This is a recursion guard, not a chain limiter — sequential plan progression is the orchestrator's job, and each delegation is depth 1 from its perspective.

### Concurrency protection

A per-project in-memory mutex ensures only one delegate call runs at a time per project. This prevents branch checkout conflicts if the model issues parallel tool calls or multiple sessions delegate concurrently. Implemented as a simple promise chain keyed by project ID (~15 lines). The second call awaits the first's completion before starting.

No SQLite-based lock — the lock protects the single working tree within one server process, and in-memory state is inherently clean on restart. If persistent locks are needed later (e.g., for task queues surviving restarts), that's a separate scope.

### Abort propagation

The tool's `execute` receives an `AbortSignal` from pi. If the parent session is aborted mid-delegation, the signal fires. The tool should call `subSession.abort()` and return an error result.

### Branch checkout coordination

No branch change needed — the parent and sub-session are on the same task branch.

### Parent tracking

Sub-sessions get a `parent_session_id` column in the sessions table (nullable FK to `sessions.id`). This gives us lineage tracking — you can trace a sub-session back to its parent, and query all sub-sessions spawned by a given session.

The `createNewSession` options grow to include `parentSessionId?: string`. The delegate tool passes its own session ID.

### Session cleanup

After the delegate tool extracts the summary, it removes the sub-session from `state.sessions` immediately. The session is already persisted to SQLite (messages saved on `turn_end`/`agent_end`), so nothing is lost. If the user later clicks into the sub-session in the UI, it resumes from SQLite like any other session. This keeps memory bounded when an orchestrator spawns many sub-sessions.

### Visibility

Sub-sessions are normal sessions in the DB, linked to the task, with a `parent_session_id` pointing at the session that spawned them. They appear in the task's session list in the UI with a visual indicator that they're delegated (e.g. an indent or badge). Events broadcast over WS as usual, so the user sees the sub-session's work in real time.

### What the sub-session sees

The sub-session is a regular task session: it gets the task system prompt ("You are working on this task"), the project's AGENTS.md context, and full coding tools. It has no knowledge of the parent session. The prompt should be self-contained.

### Autonomous execution

The delegate tool prepends a short preamble to the user's prompt instructing the sub-agent not to ask clarifying questions. If it gets stuck or needs more context, it should say so in its final message — the orchestrator can then re-delegate with additional context. This keeps the interaction model simple (no back-and-forth relay) while still letting the orchestrator course-correct.

## Implementation

### File changes

#### 1. New file: `packages/backend/src/tools/delegate.ts` ✅

Tool factory module. Contains:

- `createDelegateTool(runSubSession, depth)` — returns a `ToolDefinition`
- `execute` calls `runSubSession(prompt)` which creates a sub-session, prompts it, awaits completion, cleans up, and returns the summary

#### 2. `create_task` tool: optional `prompt` parameter

Add an optional `prompt` parameter to `create_task`. When provided, after creating the task, kick off a session on it (fire-and-forget) — create the session and call `session.prompt()` without awaiting completion. The tool returns the task info immediately. The user watches the session's progress via WS broadcast.

#### 3. `packages/backend/src/tools/index.ts` ✅

- Import `createDelegateTool`
- `CustomToolsOpts` accepts an optional `delegate` object: `{ state, sessionId, createSession }`
- Include the delegate tool in the returned array (only when in a task session)

#### 4. New migration: `012_add_parent_session_id` ✅

```sql
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
```

`ON DELETE SET NULL` so that if a parent session is ever cleaned up, the sub-session doesn't vanish — it just loses its lineage link.

#### 5. `packages/backend/src/session-store.ts` ✅

- Add `parent_session_id` to `SessionRow` and `SessionListItem`.
- Update `createSession` to accept and insert `parentSessionId`.
- Update list queries to include `parent_session_id` so the frontend can identify sub-sessions.

#### 6. `packages/backend/src/sessions.ts` ✅

- Generate session IDs upfront via `crypto.randomUUID()` before calling `createAgentSession`, so the ID can be passed to tool factories.
- Pass `{ state, sessionId, createSession }` through to `createCustomTools` as the `delegate` option.
- Export a `createSession` wrapper for injection into the delegate tool (avoids circular imports).
- `createNewSession` accepts new options: `parentSessionId?: string`.
- The per-project mutex moved from here into `delegate.ts` (it's only used by delegation).

#### 7. Frontend: session list display ✅

Sub-sessions (those with a `parent_session_id`) get a visual indicator in the task's session list — a subtle badge or label. The full session is viewable by clicking in like any other session. No structural changes to the session view itself.

### What we're NOT doing

- **Cross-task delegation.** Delegate only works within the current task. Starting work on a different task is handled by `create_task` with a `prompt` parameter (fire-and-forget).
- **Scratch session orchestration.** No orchestrator-loop from scratch sessions. Scratch can create tasks and kick off sessions, but doesn't await their completion.
- **Parallel delegation.** Single working tree means sequential only. Per-project mutex enforces this.
- **Custom sub-session model/thinking level.** Sub-sessions inherit the server's model config. Could be added later.
- **Streaming sub-session output to parent.** The parent just gets the final summary. The user sees real-time output via WS broadcast, but the parent agent doesn't.

## Open questions

1. **What if the sub-session hits an error or gets stuck in a loop?** The depth limit prevents infinite recursion. For stuck sessions, the abort signal propagation handles user-initiated cancellation. We could add a turn limit or token budget later.

2. **Should the tool accept an optional `context` parameter for injecting extra files/docs into the sub-session?** Not for v1 — the prompt can tell the sub-agent to read specific files. Task-pinned documents (a separate TODO item) would solve this more broadly.
