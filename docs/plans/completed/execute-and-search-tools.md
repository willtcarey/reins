# Execute & Search Tools

Status: **design** — not ready for implementation.

## Motivation

Agents running in Reins are blind to the system they're running in. They can create tasks and delegate, but they can't introspect — they can't query what sessions exist, read messages from other sessions, inspect task state, or investigate the database. This limits their ability to:

- Debug Reins itself (e.g., investigating persistence bugs)
- Summarize or reference previous conversations
- Coordinate across sessions (reading what another session discovered)
- Recover from partial failures by inspecting current state

## Design

Two new custom tools that give agents scriptable, curated access to Reins internals.

### `search` tool

Discovers the available API surface. The agent describes what it wants to do, and the tool returns the relevant TypeScript type signatures and function documentation.

```
search({ query: "sessions" })
→ returns session-related function signatures (list, get, messages, create, etc.)

search({ query: "create task" })  
→ returns tasks.create signature with parameter types
```

This keeps context lean — the agent only loads the types it needs rather than paying token cost for the full API spec on every call. The API surface can grow without bloating tool descriptions.

**Implementation:** Maintain a registry of API function metadata (name, description, TypeScript signature, category/tags). The search tool does fuzzy matching against names, descriptions, and tags to return relevant entries.

### `execute` tool

Takes an async JavaScript function body and runs it in a scoped context with access to a curated `api` object. Returns the function's return value (or error).

```typescript
// Agent writes:
execute({
  code: `
    const sessions = await api.sessions.list(projectId);
    const latest = sessions[0];
    const messages = await api.sessions.messages(latest.id);
    return messages.filter(m => m.role === 'user').length;
  `
})
```

The tool description explains the pattern ("write an async function using the `api` object, use the `search` tool to discover available operations") without including type definitions.

**Execution:** Scoped eval (e.g., `new Function` or `eval` in Bun) with only the `api` object bound. The agent cannot import modules or access arbitrary code — only the curated API surface.

**Error handling:** API functions throw on invalid operations (e.g., exceeding depth limits for session creation). Errors are returned to the agent as tool results, same as any other tool error.

## API surface

A curated object exposing specific functions from the stores and models layers. Not a pass-through to internals — a deliberate, stable interface.

Initial candidates:

```typescript
const api = {
  tasks: {
    list(projectId: number): TaskRow[]
    get(taskId: number): TaskRow | null
    create(projectId: number, opts: { title, description, branchName? }): TaskRow
    update(taskId: number, updates: { title?, description?, status? }): void
  },
  sessions: {
    list(projectId: number, opts?: { taskId?: number | null }): SessionListItem[]
    get(sessionId: string): SessionRow | null
    messages(sessionId: string): Message[]
    create(projectId: number, opts?: { taskId?, prompt? }): { sessionId: string }
  },
  projects: {
    list(): ProjectRow[]
    get(projectId: number): ProjectRow | null
  },
}
```

Git is explicitly **not** part of this API — the agent already has full git access through bash, and git commands are self-documenting.

### What to expose — principles

- **Read-heavy.** Most operations should be reads. Writes are fine but should go through model-layer functions that enforce business rules (e.g., task creation includes branch creation).
- **Don't duplicate bash.** If the agent can already do it well through bash (git, file operations, etc.), don't wrap it.
- **Evolvable interface.** The `search` tool means agents discover the API fresh each time, so renaming functions or changing signatures doesn't break anything. No need to treat the API as a frozen contract.
- **Errors over silent failures.** Functions throw with descriptive messages rather than returning nulls or empty results for invalid inputs.
- **No raw SQL.** The curated API should cover common needs. If we find agents frequently need ad-hoc queries, we can add a `db.query()` function for read-only SQL as an escape hatch.

## Relationship to existing tools

- **`create_task`** — Could eventually decompose into `api.tasks.create()` + `api.sessions.create()` called from `execute`. But `create_task` bundles git branch creation and session kickoff with a nice UX for the agent. Keep it as a dedicated tool; the execute API can offer the same primitives for more complex orchestration.
- **`delegate`** — Stays as a dedicated tool. It has orchestration semantics (awaiting completion, depth limits, serialization) that go beyond what `execute` should handle. The execute tool's `api.sessions.create()` could offer fire-and-forget session creation but not the synchronous delegation pattern.

## Inspiration

Cloudflare's [Codemode](https://developers.cloudflare.com/agents/api-reference/codemode/) takes a similar approach — LLMs write code against a typed API rather than making individual tool calls. Key differences:

- Codemode uses Worker sandboxes for network isolation. We don't need that — agents already have bash access on the local machine. A scoped eval is sufficient.
- Codemode auto-generates types from tool definitions and stuffs them in the tool description. We use a separate `search` tool for incremental schema discovery.
- Codemode focuses on orchestrating external tools within a single turn. Our `execute` tool also enables cross-session introspection and coordination.

## Open questions

1. **Console capture.** Should `console.log` in execute scripts be captured and returned? Useful for debugging. Cloudflare does this.
2. **Timeout.** Should execute have a timeout? Probably yes — a runaway loop shouldn't block the agent indefinitely.
3. **Multi-statement results.** If the script has multiple return-worthy values, does it just use the final `return`? Or should we capture intermediate results?
4. **Search implementation.** Fuzzy text matching? Keyword tags? Embedding-based search? Start simple (keyword/tag matching) and iterate.
5. **Async operations.** Should `api.sessions.create()` with a prompt be fire-and-forget or await completion? Probably fire-and-forget (delegate handles the await pattern).
6. **Scoping by session type.** Should task sessions have a different API surface than scratch sessions? Or same surface, different defaults (e.g., task sessions auto-scope to their project)?
