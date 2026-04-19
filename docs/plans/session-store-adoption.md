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

Raw entries from `append()` have rich metadata beyond `type` and `message`:

- **User message:** `{ type: "user", message: { role: "user", content: [...] }, uuid, parentUuid, sessionId, cwd, timestamp, isSidechain, promptId, permissionMode, userType, entrypoint, version, gitBranch }`
- **Assistant message:** `{ type: "assistant", message: { role: "assistant", content: [...], model, usage, id, stop_reason, ... }, uuid, parentUuid, sessionId, cwd, timestamp, isSidechain, requestId, ... }`
- **Tool result:** user entry with `content: [{ tool_use_id, type: "tool_result", content }]` plus `toolUseResult` and `sourceToolAssistantUUID` metadata

Non-conversation entries (`queue-operation`, `ai-title`, `last-prompt`) are not required for resume.

**Important (0.2.114):** The metadata fields on entries are required for resume — entries stripped to just `type`, `message`, `uuid`, `parentUuid` fail with "No conversation found". The subprocess uses these fields to validate and reconstruct the session. This was not apparent in earlier 0.2.112 testing.

### 3. UUIDs can be rewritten but not omitted

Rewrote all UUIDs to fresh random values in `load()` — resume works fine, prompt caching is unaffected. However, entries must still include `uuid` and `parentUuid` fields (they can't be omitted entirely).

### 4. Fake conversations work (with correct entry structure)

Fabricated a complete conversation from scratch in 0.2.112 testing. The entries still needed the full metadata shape — "fake" meant the content was fabricated, not that the entry structure was simplified.

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

### Implementation status

**Built:**
- `toSessionStoreEntries()` translator: `AgentRuntimeMessage[] → SessionStoreEntry[]` with tool name/arg denormalization, tool result merging, consecutive assistant merging, compaction summary conversion, and UUID chain generation. Fully tested.
- `createSessionStore()` factory: returns a `SessionStore` with `load()` reading from our SQLite via `loadMessagesForLLM()` → `toSessionStoreEntries()`, no-op `append()`, empty `listSubkeys()`. Tested with real DB.
- Verification script (`packages/backend/scripts/session-store-load-test.ts`): end-to-end test that runs a session, persists to our format, and resumes via `load()`.

**Blocked: entries from our translator don't resume correctly.**

The SDK subprocess requires metadata fields on each entry beyond `type`, `message`, `uuid`, and `parentUuid`. Through systematic testing we found:

1. Raw entries from `append()` (with all metadata: `sessionId`, `cwd`, `isSidechain`, `timestamp`, `version`, `gitBranch`, etc.) → **resume works**
2. Raw entries filtered to only user/assistant types (dropping `queue-operation`, `ai-title`, `last-prompt`) → **resume works** (these non-conversation entries are optional)
3. Raw entries stripped to just `type` + `message` + `uuid` + `parentUuid` → **fails** ("No conversation found")
4. Our translated entries with `sessionId` added → **fails** ("No conversation found")
5. Raw metadata grafted onto our translated `message` objects → **different error** ("400 due to tool use concurrency issues") — gets past session lookup but the message content structure is rejected

This tells us two things:
- **Metadata fields on entries are required** for the subprocess to find the session
- **Our `message` objects differ structurally** from what the API expects (likely missing `id`, `model`, `usage` on assistant messages, or subtle differences in tool_result content format)

### Revised approach: store raw entries via append()

Since translating from our format back to SDK format is fighting the opaque internal structure, the simpler path is:

1. **`append()` stores raw entries** — write the SDK's own entries to a new SQLite table (or JSONL column) as opaque blobs, alongside our existing `AgentRuntimeMessage` persistence for display
2. **`load()` returns stored raw entries** — read them back as-is for resume
3. **Context pruning operates on raw entries** — modify `message.content` fields in the raw entries (text rewriting, tool result truncation) rather than translating between formats
4. Keep our existing `AgentRuntimeMessage` persistence for the frontend/display layer

This is a dual-write approach: `append()` stores the SDK's native format for resume, our persistence observer stores our format for display. The `load()` interception point still gives us control over what the model sees.

### What this enables

**A. Context pruning via `load()`** (connects to [context-pruning plan](context-pruning.md))

The most compelling use case. `load()` is the insertion point for building a "derived prompt view":

- Strip old tool results, replace with summaries
- Drop attachment entries (skill listings, deferred tool deltas)
- Truncate large assistant responses
- Apply cache-aware pruning (keep full content while cache is warm)

The canonical transcript stays in our database; `load()` returns the pruned version. With the revised approach, pruning operates directly on the raw SDK entries rather than translating between formats.

**B. Cross-session context injection**

Fabricate conversation history from other sources — e.g., inject relevant context from previous sessions, documentation, or external knowledge bases as if the model had already seen them.

**C. Capture compaction summaries**

Register a `PostCompact` hook to capture `compact_summary` instead of showing a placeholder. Independent of SessionStore adoption.

## Open Questions

1. ~~**How does this interact with our conversation tree model?**~~ Not a concern today — we only support a single linear conversation. If/when we add branching, it would work like compaction: kill the session and `load()` with the selected branch's messages.

2. ~~**Is `@alpha` stability acceptable?**~~ Yes. We only depend on `load()`, and the SDK will always need some way to load conversations — the exact shape may shift but the capability won't disappear.

3. **What's the storage cost of dual-write?** Raw SDK entries include verbose metadata (cwd, version, gitBranch, etc.) on every entry. Need to measure the size overhead vs. our compact `AgentRuntimeMessage` format.

## Suggested Next Steps

1. **Immediate (no SessionStore needed):** Register `PostCompact` hook to capture actual compaction summaries.
2. **Short term:** Wire up `SessionStore` with `append()` storing raw entries to a new SQLite table and `load()` returning them. This gives us the `load()` interception point without needing format translation.
3. **Medium term:** Implement context pruning in `load()` — modify raw entries to strip/summarize old tool results before returning them.

## Test Script

`packages/backend/scripts/session-store-explore.ts` — runnable exploration script that exercises the SessionStore API. Run with `bun run packages/backend/scripts/session-store-explore.ts`.
