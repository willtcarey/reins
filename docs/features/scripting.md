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
| `api.sessions` | `list(options?)`, `listForTask(taskId)`, `get(sessionId)`, `current()`, `messages(sessionId, options?)`, `toolTrace(sessionId, options?)` |
| `api.projects` | `list()`, `get(projectId)`, `current()` |
| `api.models` | `list()`, `listProviders()` |
| `api.ui` | `openFile(path, startLine?, endLine?)` |

### Behavior

- **Read-heavy** — most operations are reads. Writes go through the app's normal task/session flows.
- **Scoped by default** — `tasks.list()`, `sessions.list()`, and `projects.current()` default to the session's project. `sessions.list({ projectId })` can target another project, and session reads by `sessionId` can inspect sessions across projects.
- **Incremental session queries** — `sessions.list()` returns all sessions for the current project; `sessions.list(options?)` supports `projectId`, `taskId`, `since`, `limit`, `search`, and `minMessages`. Use `taskId: "current"` from a task session to list that task's sessions; `projectId: "current"` refers to the script's project. `sessions.messages(sessionId, options?)` supports role/search filters, sequence cursors, `since`, `limit`, and `order`.
- **Tool trace extraction** — `sessions.toolTrace()` returns compact `toolCall` and `toolResult` records in sequence. It supports filters like `toolName`, `isError`, `search`, sequence cursors, and `limit`; raw result `content` is only included when `includeContent: true` is passed.
- **30-second timeout** — runaway scripts are killed after 30s.
- **No imports** — only the `api` object is available. No `require`, `import`, or filesystem access.

### Typical workflow

1. Agent calls `search({ query: "sessions" })` to find message and tool-trace functions and see the relevant interfaces.
2. Agent calls `execute({ code: ... })` with a script that filters sessions/messages incrementally, e.g. recent messages or failed tool results.
3. Agent uses the returned data in its response.
