# Project Assistant Session

Status: **ready for implementation**

## Goal

Add a prominent "assistant" conversation to each project — an always-available, long-lived session displayed at the top of the sidebar. Useful for quick questions, brainstorming, exploring the codebase, and lightweight interactions that don't warrant a task.

## Concept

The assistant is not a new session type — it's a **UI concept**. The most recent scratch session is promoted to "assistant" status and pinned at the top of the sidebar. Under the hood it's a regular scratch session.

- **Always visible** at the top of the sidebar, above tasks.
- **Long-lived** — the user keeps talking to the same session rather than creating new ones.
- Clicking it navigates to that session. If no scratch session exists yet, one is created.
- **"New conversation"** creates a new scratch session, which becomes the new assistant. The previous one drops into a hidden archive.

This means: no schema changes, no new session type, no new backend endpoints.

## Data Model

No changes to the session schema. The assistant is the first item from the existing `listSessions` query (most recent scratch session, ordered by `updated_at DESC`).

## Compaction: Preserve History

The assistant session will accumulate messages over time and trigger pi's auto-compaction. Today, compaction is destructive — `replaceAllMessages` deletes all stored messages and writes the compacted set. For a long-lived assistant session, we want to **preserve the full history** for display while only sending recent context to the LLM.

### Approach

When compaction fires:

1. **Keep all existing messages** in `session_messages` — don't delete them.
2. **Insert a compaction summary message** — a special message row that marks the compaction boundary and contains the summary. Use a distinct role (e.g. `"compaction_summary"`) or a flag in the JSON blob.
3. **New messages continue** with seq numbers after the summary.

Two loading modes:

- **For the LLM** (resume path, `agent.replaceMessages`): load messages from the last compaction summary onward. This is what gets sent to the model — compact context window.
- **For display** (GET session endpoint, chat panel): load all messages. The user sees the full conversation history, with compaction summaries rendered as visual dividers.

### Changes

**`session-store.ts`:**

- **`replaceAllMessages`** → rename/rework to **`applyCompaction`**. Instead of delete-all + reinsert, it:
  1. Inserts a compaction summary message at the next seq number with role `"compaction_summary"` and the summary content.
  2. Inserts the post-compaction messages after the summary.
  3. Leaves all pre-compaction messages in place.
- **`loadMessages(sessionId)`** — unchanged, returns all messages (for display).
- **`loadMessagesForLLM(sessionId)`** — new function. Finds the last compaction summary's seq number and loads only messages after it. If no compaction summary exists, loads all messages (same as today).

**`sessions.ts`:**

- `wireSession` compaction handler: call `applyCompaction` instead of `replaceAllMessages`.
- `resumeSession`: use `loadMessagesForLLM` when hydrating the agent with `replaceMessages`.

**`routes/sessions.ts`:**

- GET session endpoint continues to use `loadMessages` (full history) — no change needed.

**Chat panel (`chat-panel.ts`):**

- Render compaction summary messages as a visual divider/separator (e.g. a horizontal rule with "Conversation summarized" label), not as a regular chat bubble.

### Note

This compaction change applies to **all sessions**, not just the assistant. It's harmless for short-lived sessions (compaction rarely triggers) and beneficial for any session that happens to run long. No need to scope it to a specific session type.

## Frontend Changes

### Session Sidebar (`session-sidebar.ts`)

Replace the current scratch session list with:

1. **Assistant button** — always visible at the top of the sidebar content (above the task list). Shows the most recent scratch session. Highlighted when active. Activity dot when running/finished.
2. **Old scratch sessions** — hidden by default. A small expandable section ("Previous sessions") reveals them if the user wants to revisit one. Not fetched on initial load.

The "New Session" button becomes a "New conversation" action (on the assistant button or nearby). It creates a new scratch session, which takes over as the assistant.

### Project Store (`project-store.ts`)

- On `fetchLists`, continue fetching scratch sessions as today, but the sidebar only uses the first item as the assistant.
- Optionally defer fetching the full scratch session list until the user expands "Previous sessions".

### Bare Project URL Resolution

No change needed — `setRoute` already resolves `#/project/:id` to the most recent scratch session, which is the assistant.

## Implementation Steps

1. **Compaction rework** — replace destructive `replaceAllMessages` with `applyCompaction` that preserves history and inserts a summary marker. Add `loadMessagesForLLM`. Update `wireSession` and `resumeSession`.
2. **Chat panel** — render compaction summary messages as visual dividers.
3. **Sidebar UI** — extract the assistant (first scratch session) and display it as a pinned button at the top. Hide remaining scratch sessions behind a collapsible section.
4. **"New conversation"** — wire up an action that creates a new scratch session and navigates to it (it becomes the new assistant automatically since it's the most recent).
5. **Lazy fetch of old sessions** — optionally defer loading the full scratch session list until the user expands the archive section.
6. **Feature doc** — update `docs/features/projects.md` or create a new doc.

## Future Work

- **Lazy message loading.** Once assistant sessions accumulate long histories (spanning multiple compactions), loading all messages upfront will become expensive. Add paginated/lazy loading — fetch recent messages first, load older ones as the user scrolls up. Not needed for v1.
