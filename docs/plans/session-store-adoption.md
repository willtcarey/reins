# SessionStore Adoption

Status: **research complete** — ready for design decisions.

The Claude Agent SDK added a `SessionStore` API in 0.2.114 (`@alpha`) that lets us intercept, mirror, and rewrite session transcripts. This plan captures our findings from exploration and lays out how we could use it.

## What SessionStore is

A dual-write adapter for session transcripts. The subprocess still writes to local JSONL on disk; the store receives a secondary copy. On resume, the SDK calls `store.load()` once in the parent process, materializes the result to a temp file, and spawns the subprocess from that — meaning **`load()` controls what the model sees**.

## API Surface

```ts
type SessionStore = {
  // Required — called after each local write, ~100ms cadence, at-most-once
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;

  // Required — called once before subprocess spawn on resume
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;

  // Optional — list sessions for a project
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;

  // Optional — no-op if omitted (WORM-safe)
  delete?(key: SessionKey): Promise<void>;

  // Optional — discover subagent transcripts for resume
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
};

type SessionKey = {
  projectKey: string;   // sanitized cwd or tenant ID
  sessionId: string;
  subpath?: string;     // undefined = main transcript, set for subagents
};

type SessionStoreEntry = {
  type: string;         // discriminant: "user", "assistant", "attachment", etc.
  uuid?: string;
  timestamp?: string;
  [k: string]: unknown; // opaque pass-through
};
```

Also ships: `InMemorySessionStore` (test impl), `importSessionToStore()` (migration helper), `SDKMirrorErrorMessage` (error event when append fails).

The `sessionStore` option is accepted on: `query()` options, `getSessionInfo()`, `getSessionMessages()`, `getSubagentMessages()`, `listSessions()`, `listSubagents()`, `deleteSession()`, `forkSession()`.

## Findings from Exploration

We built a test harness (`packages/backend/scripts/session-store-explore.ts`) and confirmed:

### 1. Call sequence

**New session:** `append()` called in batches after each turn completes. A single turn produces one batch with all entries (queue-ops, user, attachments, assistant, title).

**Resume:** `load()` → `listSubkeys()` → subprocess spawn → `append()` for new turns.

### 2. Transcript entry shapes

The minimum viable entries for a conversation turn:

- **User message:** `{ type: "user", message: { role: "user", content: [...] }, uuid, parentUuid, ... }`
- **Assistant message:** `{ type: "assistant", message: { role: "assistant", content: [...], model, usage, ... }, uuid, parentUuid, ... }`
- **Tool call:** assistant entry with `content: [{ type: "tool_use", id, name, input }]`, `stop_reason: "tool_use"`
- **Tool result:** user entry with `content: [{ tool_use_id, type: "tool_result", content }]`

Optional entries (not required for resume): `queue-operation`, `attachment` (deferred_tools_delta, skill_listing), `ai-title`, `last-prompt`.

Metadata fields like `toolUseResult` and `sourceToolAssistantUUID` on tool result entries are for Claude Code internal bookkeeping (undo/rewind) — not required for resume.

### 3. UUIDs are not load-bearing

Rewrote all UUIDs to fresh random values in `load()`. Resume works fine, prompt caching is unaffected. The API caches based on message content, not metadata.

### 4. Fake conversations work

Fabricated a complete conversation from scratch (never ran a real session 1), returned it from `load()`, and the model resumed from it as if it were real. Minimum needed: user + assistant entry pairs with valid content blocks.

### 5. Mid-conversation rewrite works

Ran a session establishing "favorite color is blue", then had `load()` rewrite "blue" → "red" in all text content. On resume, the model confidently said "red" — it sees only what `load()` returns.

### 6. Prompt caching works normally

Store-based resume has identical cache behavior to file-based resume. No penalty from materializing via the store.

### 7. Compaction happens mid-turn

Compaction fires during the agentic loop (between API calls within a turn), not between user turns. The flow: status `compacting` → `PreCompact` hook → summarize → `PostCompact` hook (carries `compact_summary`) → `SessionStart` with `source: 'compact'` → instructions reload → `compact_boundary` message.

Reins currently doesn't capture the actual compaction summary — we emit a placeholder notice. The `PostCompact` hook provides `compact_summary` but we don't register it.

### 8. No direct way to disable auto-compaction via SDK

`autoCompactWindow` is a user preference, not an SDK option. Could potentially pass via `extraArgs` if the CLI supports it, but undocumented.

### 9. Custom compaction is stop→rewrite→resume

To do our own compaction: monitor `input_tokens` on each assistant event, call `query.close()` when threshold is hit, rewrite entries in the store, resume with `load()` returning compacted transcript. The model loses in-progress generation but conversation history is preserved.

## Design Decision: load()-only, not persistence

We don't need `SessionStore` for persistence. We already have our own persistence layer (SQLite `session_messages` table) and the SDK writes its own JSONL files to disk. Adding `append()` as a persistence path would mean maintaining two formats and accepting at-most-once delivery semantics for no real benefit.

What we _do_ need is `load()` — the ability to control what the model sees on resume. This is the only part of the `SessionStore` API we should adopt.

### How it works

1. Keep our existing persistence as-is (runtime-persistence-observer → SQLite)
2. On resume, implement `load()` to translate our persisted `AgentRuntimeMessage[]` into `SessionStoreEntry[]`
3. `append()` is a no-op (or lightweight logging) — the SDK's own JSONL files handle its internal bookkeeping
4. The SDK calls `load()` once before subprocess spawn, materializes the result to a temp file, and the model resumes from that

### Translation: AgentRuntimeMessage → SessionStoreEntry

Our format (`AgentRuntimeMessage`):
```
{ role: "user", content: [{ type: "text", text: "..." }] }
{ role: "assistant", content: [{ type: "text", text: "..." }, { type: "toolCall", id, name, arguments }], stopReason: "toolUse" }
{ role: "toolResult", toolCallId: "...", content: [{ type: "text", text: "..." }] }
{ role: "compactionSummary", summary: "..." }
```

SDK format (`SessionStoreEntry`):
```
{ type: "user", message: { role: "user", content: [{ type: "text", text: "..." }] } }
{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "..." }, { type: "tool_use", id, name, input }], stop_reason: "tool_use" } }
{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "...", content: "..." }] } }
```

Key translations:
- `toolCall` blocks → `tool_use` blocks (camelCase args back to snake_case, `arguments` → `input`)
- `toolResult` messages → user messages with `tool_result` content blocks
- Tool results belonging to the same assistant turn get merged into a single user entry
- `compactionSummary` → user message with plain string content (SDK convention)
- Tool names: reverse the normalization (`read` → `Read`, `bash` → `Bash`, custom tools → `mcp__custom-tools__` prefix)

### What this enables

**A. Context pruning via `load()`** (connects to [context-pruning plan](context-pruning.md))

The most compelling use case. `load()` is the insertion point for building a "derived prompt view":

- Strip old tool results, replace with summaries
- Drop attachment entries (skill listings, deferred tool deltas)
- Truncate large assistant responses
- Apply cache-aware pruning (keep full content while cache is warm)

The canonical transcript stays in our database; `load()` returns the pruned version.

**B. Cross-session context injection**

Fabricate conversation history from other sources — e.g., inject relevant context from previous sessions, documentation, or external knowledge bases as if the model had already seen them.

**C. Capture compaction summaries**

Register a `PostCompact` hook to capture `compact_summary` instead of showing a placeholder. Independent of SessionStore adoption.

## Open Questions

1. ~~**How does this interact with our conversation tree model?**~~ Not a concern today — we only support a single linear conversation. If/when we add branching, it would work like compaction: kill the session and `load()` with the selected branch's messages.

2. ~~**Is `@alpha` stability acceptable?**~~ Yes. We only depend on `load()`, and the SDK will always need some way to load conversations — the exact shape may shift but the capability won't disappear.

## Suggested Next Steps

1. **Immediate (no SessionStore needed):** Register `PostCompact` hook to capture actual compaction summaries.
2. **Short term:** Build the `AgentRuntimeMessage[] → SessionStoreEntry[]` translator and wire up a `SessionStore` with a real `load()` and no-op `append()`. This gives us control over resume content without changing persistence.
3. **Medium term:** Implement context pruning in `load()` — the derived prompt view from the context-pruning plan.

## Test Script

`packages/backend/scripts/session-store-explore.ts` — runnable exploration script that exercises the SessionStore API. Run with `bun run packages/backend/scripts/session-store-explore.ts`.
