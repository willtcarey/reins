# Execute & Search Tools

Agents have two tools for scriptable access to Reins internals.

## `search` — Discover the API

The `search` tool returns function signatures, descriptions, and type definitions rendered from TypeBox schemas. Query by category, function name, or description.

```
search({ query: "sessions" })       → session-related functions + types
search({ query: "tasks.create" })   → create signature with param types
search({ query: "" })               → full API surface
```

Results include referenced domain types (Task, Session, Project, etc.) so the agent can understand the shape of returned data.

## `execute` — Run scripts against Reins

The `execute` tool runs async JavaScript against a curated `api` object. The agent writes a function body; only the `api` object is in scope.

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
| `api.tasks` | `list()`, `get(taskId)`, `create(title, description, branchName?)`, `update(taskId, updates)` |
| `api.sessions` | `list()`, `listForTask(taskId)`, `get(sessionId)`, `messages(sessionId)` |
| `api.projects` | `list()`, `get(projectId)`, `current()` |

### Design

- **Schema-driven** — domain types (Task, Session, Project, etc.) are defined as TypeBox schemas. Function signatures and type docs are rendered from these schemas automatically — no hand-maintained strings.
- **Domain types** — separate from store types (TaskRow, SessionRow) even though they map 1:1 today. The domain types are the agent-facing contract.
- **Read-heavy** — most operations are reads. Writes go through the model layer (e.g., `tasks.create` handles git branch creation).
- **Scoped to current project** — `tasks.list()`, `sessions.list()`, and `projects.current()` operate on the session's project.
- **30-second timeout** — runaway scripts are killed after 30s.
- **No imports** — only the `api` object is available. No `require`, `import`, or filesystem access.

### Typical workflow

1. Agent calls `search({ query: "messages" })` to find `sessions.messages()` and see the Message type.
2. Agent calls `execute({ code: ... })` with a script that reads messages from another session.
3. Agent uses the returned data in its response.
