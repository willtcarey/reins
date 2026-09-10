# Scripting

Agents have two tools for scriptable access to Reins internals.

## `search` — Discover the API

The `search` tool discovers Reins internal API functions for `execute` scripts against Reins-managed data or UI state. It returns documentation-only TypeScript interfaces for the existing `api` object and referenced domain types, filtered by query.

```
search({ query: "sessions" })       → partial Api interface for session-related functions + types
search({ query: "tasks.create" })   → Api interface containing the create method + referenced types
search({ query: "" })               → full API surface
```

Results include related data shapes (`Task`, `Session`, `Project`, etc.) as TypeScript interfaces. The returned interfaces are documentation only: `execute` scripts should call methods on the existing `api` object with positional arguments, e.g. `api.tasks.update(taskId, updates)`.

## `execute` — Run scripts against Reins

The `execute` tool runs async JavaScript against a curated `api` object for Reins-managed data and UI state. The agent writes a function body; only the `api` object is in scope.

```javascript
execute({
  code: `
    const tasks = api.tasks.list();
    const open = tasks.filter(t => t.status === 'open');
    return open.map(t => ({ title: t.title, sessions: t.session_count }));
  `
})
```

### API namespaces

| Namespace | Functions |
|---|---|
| `api.tasks` | `list(status?)`, `get(taskId)`, `current()`, `create(title, description, branchName?)`, `update(taskId, updates)`, `close(taskId)`, `reopen(taskId)` |
| `api.sessions` | `list(options?)`, `get(sessionId)`, `current()`, `entries(sessionId, options?)`, `setModel(sessionId, provider, modelId, thinkingLevel?)`, `start(prompt, options)`, `send(sessionId, message)`, `wait(sessionId, timeoutMs?)` |
| `api.projects` | `list()`, `get(projectId)`, `current()` |
| `api.models` | `list()`, `listProviders()` |
| `api.reviews` | `current()`, `addComment(path, line, body, options?)` |
| `api.ui` | `openFile(path, startLine?, endLine?)` |

### Behavior

- **Read-heavy** — most operations are reads. Writes go through the app's normal task/session/review flows.
- **Code review comments** — `reviews.addComment()` anchors a comment to the current branch diff and atomically creates the pending project/task review when needed. It defaults to one new-side line and author `Agent`; `options` can set `endLine`, `side`, or `author`. Reins derives the structured anchor and retains the exact Git-native per-file patch server-side rather than requiring scripts to construct either value.
- **Scoped by default** — `tasks.list()`, `sessions.list()`, and `projects.current()` default to the session's project. `sessions.list({ projectId })` can target another project, and session reads by `sessionId` can inspect sessions across projects.
- **Incremental session queries** — `sessions.list()` returns all sessions for the current project; `sessions.list(options?)` supports `projectId`, `taskId`, `since`, `limit`, `search`, and `minMessages`. Use `taskId: "current"` from a task session to list that task's sessions; `projectId: "current"` refers to the script's project.
- **Unread session activity** — session results expose `unread: true/false`. Find unread sessions with `api.sessions.list().filter(s => s.unread)`. This is derived from persisted `activity_state`: `"finished"` means unread; `"running"` and `null` mean not unread. The activity field remains available for distinguishing active work from no pending activity. API reads do not mark sessions read. Child sessions do not participate in activity tracking.
- **Session entry extraction** — `sessions.entries(sessionId, options?)` returns a mixed timeline of persisted message entries (`user`, `assistant`, `compactionSummary`) and derived `toolCall` entries. Tool call entries include joined result previews when available. It supports `types`, `toolName`, `isError`, `search`, sequence cursors, `since`, `limit`, and `order`; raw joined result `content` is only included when `includeContent: true` is passed.
- **30-second synchronous execution limit** — the VM limits synchronous computation, not arbitrary async promises. Session waits have their own bounded timeout.
- **No imports** — only the `api` object is available. No `require`, `import`, or filesystem access.

### Start, message, and wait for sessions

When asked to delegate or run parallel sessions, an agent uses `api.sessions` through `execute`, rather than a blocking delegate tool:

```javascript
const child = await api.sessions.start("Investigate the failing tests. Report findings without editing.", {
  parentSessionId: "current",
  title: "Test investigation",
});
return child; // { sessionId }; does not wait for the response
```

`options.parentSessionId` is required: `"current"` creates a child of the caller; `null` creates an independent session. Both stay in the caller's project/task with a fresh conversation. Child nesting is limited to three levels. Optional `title` reuses the existing session name; omitting it preserves normal first-message naming. `modelProvider` and `modelId` can override the inherited model together; `thinkingLevel` can override inherited thinking.

Follow up in a later script using only the session ID:

```javascript
await api.sessions.send(sessionId, "Also check the cancellation case.");
return await api.sessions.wait(sessionId, 10000);
```

- **send** reopens a persisted session if needed. When idle, it starts a normal prompt. When busy, it uses native steering—there is no delivery mode parameter or queued follow-up operation. Sending and starting return without waiting for a response.
- Busy Claude sessions reject steering: wait for idleness and send again. Pi forwards steering directly to its SDK, including during compaction, and propagates native errors. Pi controls when accepted steering is consumed; without an active loop, it may remain pending until later native work.
- No hidden waiting, automatic retry, unsent-message table, or cancellation/restart fallback. Explicit abort remains separate; if you want to interrupt work, abort it deliberately before sending again.
- Pi may report idle during startup, so an immediate wait can return before work begins; Reins does not serialize concurrent startup sends or mask this native limitation with extra state.
- **wait** observes native session idleness, including native steering, retries and compaction—not one particular message. Pi returns its latest transcript outcome rather than replaying a retained prompt error; background startup failures are logged. It returns `{ sessionId, status, result, error }`. Status is `completed`, `failed`, `cancelled`, `idle` (no assistant response), or `timeout`.
- Wait defaults to 10 seconds, accepts 0–30,000 milliseconds, and can be repeated after timeout. Already-settled sessions return immediately. Cancelling the waiting script does not cancel the other session; a session cannot wait for itself.
- There are **no run IDs or receipts**. Runtimes own live execution; transcripts remain in SQLite. Waiting on a closed session reads its saved transcript without launching a runtime. There is no delivery queue to replay after a server restart, and transient execution failures are not recoverable from runtime state after restart/eviction.
- Execution operations are limited to the caller's project/task. Sessions share the checkout, so agents must coordinate edits. Parent relationships do not isolate files, propagate cancellation, or automatically inject results/wake up parents. Results are retrieved explicitly with `wait` or transcript reads.

### Create a code review

This `execute` script creates the review implicitly with its first comment and adds a same-side range comment:

```javascript
const review = await api.reviews.addComment(
  "src/example.ts",
  12,
  "This branch can return the wrong value.",
  { endLine: 14, side: "new", author: "Review Bot" },
);
return { reviewId: review.id, revision: review.revision };
```

The path and line range must exist in the current Git diff. Additional calls add comments to the same pending review in the current project/task scope.

### Typical workflow

1. Agent calls `search({ query: "sessions" })` to find session list/entry functions and see the relevant interfaces.
2. Agent calls `execute({ code: ... })` with a script that filters sessions/messages incrementally, e.g. recent messages or failed tool calls.
3. Agent uses the returned data in its response.
