# Project Assistant Session

Status: **ready for implementation**

## Goal

Add a long-lived "assistant" session to each project — an always-available conversation that doesn't require creating a task or starting a new scratch session. Useful for quick questions, brainstorming, exploring the codebase, and lightweight interactions that don't warrant their own session.

## Concept

Every project gets exactly one assistant session. It's created lazily (on first use) and persists indefinitely. Unlike scratch sessions, the assistant session:

- Is **always visible** in the sidebar — it doesn't get buried in a list.
- **Cannot be deleted** by the user (it's intrinsic to the project).
- Has a **fixed identity** — reopening it resumes the same conversation.
- Does **not** check out a branch or carry task context — it operates on whatever branch is currently checked out.

The assistant session is a regular `sessions` row with a marker distinguishing it from scratch and task sessions.

## Data Model

Add a nullable `kind` column to the `sessions` table:

- `NULL` — scratch session (existing behavior, backward-compatible default)
- `'assistant'` — the project's assistant session
- `'task'` — task session (existing behavior, identified by non-null `task_id`)

Migration:

```sql
ALTER TABLE sessions ADD COLUMN kind TEXT;
```

The `kind` column is informational for scratch/task sessions (they continue to work as before). For the assistant session it serves as the lookup key: "find the session where `project_id = ? AND kind = 'assistant'`".

**Uniqueness constraint:** Enforce at most one assistant session per project at the application level (a unique partial index would also work: `CREATE UNIQUE INDEX idx_one_assistant_per_project ON sessions(project_id) WHERE kind = 'assistant'`). Use the partial index approach for safety.

## Backend Changes

### Session Store (`session-store.ts`)

- **`getAssistantSession(projectId: number): SessionRow | null`** — look up the assistant session for a project.
- **`createSession`** — accept an optional `kind` parameter and persist it.

### Sessions (`sessions.ts`)

- **`openAssistantSession(state, projectId, projectDir): ManagedSession`** — get-or-create the assistant session. If the row exists, resume it. If not, create a new session with `kind = 'assistant'`. No branch checkout, no task context.

### Routes (`routes/sessions.ts`)

- **`POST /api/projects/:id/assistant`** — open (get-or-create) the assistant session. Returns the same `SessionData` shape as other session endpoints. Idempotent — calling it multiple times returns the same session.
- **`GET /api/projects/:id/assistant`** — return the assistant session's data if it exists, 404 otherwise. (Alternatively, fold this into the existing `GET /sessions/:sessionId` endpoint since the session has a normal ID once created.)

### Session Listing

`listSessions` currently returns sessions where `task_id IS NULL`. Update the filter to also exclude `kind = 'assistant'` so the assistant session doesn't appear in the scratch session list:

```sql
WHERE s.project_id = ? AND s.task_id IS NULL AND (s.kind IS NULL OR s.kind != 'assistant')
```

## Frontend Changes

### Project Store (`project-store.ts`)

- Add `assistantSessionId: string | null` to the store's state.
- On `fetchLists` (or a separate lightweight call), fetch the assistant session ID if it exists. The `POST /assistant` endpoint is only called when the user actually opens it.
- **`openAssistantSession(): Promise<string | null>`** — call `POST /api/projects/:id/assistant`, store the returned session ID, return it for navigation.

### Router (`router.ts`)

Add a route for the assistant session:

- `#/project/:id/assistant` — view the project's assistant session.

This could alternatively reuse the existing `#/project/:id/session/:sessionId` route once the session is created, but a dedicated route makes the "open assistant" action simpler (no need to know the session ID upfront).

### Session Sidebar (`session-sidebar.ts`)

Add an "Assistant" entry at the top of the sidebar content (above tasks and scratch sessions). This is a single, always-visible button — not a list.

- If the assistant session doesn't exist yet, clicking it creates one (via `openAssistantSession()`), then navigates to it.
- If it exists, clicking navigates directly.
- Highlight it when it's the active session.
- Show the activity dot when the assistant session is running/has new activity.

### Bare Project URL Resolution

Currently, navigating to `#/project/:id` resolves to the most recent scratch session. Update `setRoute` in `ProjectStore` so that if there are no scratch sessions, it resolves to the assistant session instead (or keep current behavior and let the user click the assistant button explicitly). Leaning toward **no change** here — the assistant is always one click away, and auto-resolving to it could be confusing if the user has tasks.

## Implementation Steps

1. **Migration** — add `kind` column and partial unique index.
2. **Backend store + sessions** — `getAssistantSession`, updated `createSession`, `openAssistantSession` function.
3. **Backend route** — `POST /api/projects/:id/assistant` endpoint.
4. **Update `listSessions` filter** — exclude assistant sessions from scratch list.
5. **Frontend store** — `assistantSessionId` state, `openAssistantSession()` action.
6. **Frontend router** — add `#/project/:id/assistant` route (or navigate via session ID).
7. **Frontend sidebar** — assistant button in `session-sidebar.ts`.
8. **Feature doc** — update `docs/features/projects.md` or create a new doc.

## Open Questions

1. **Name reset / clear conversation.** Should the user be able to "reset" the assistant session (clear its history and start fresh)? This could be a "Clear conversation" action rather than delete + recreate. Not needed for v1 but worth considering.
2. **System prompt.** Should the assistant session get a distinct system prompt hint (e.g. "You are the project assistant for quick questions and brainstorming")? Leaning toward no — the default pi system prompt with the project's AGENTS.md context is sufficient.
3. **Compaction.** The assistant session will accumulate messages over time. Pi's auto-compaction already handles this, so no special handling needed — but worth monitoring that long-lived sessions compact gracefully.
