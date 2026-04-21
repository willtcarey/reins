# SessionStore Adoption

Status: **ready to implement** — minimum metadata requirements confirmed, translator approach validated.

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

**Minimum metadata for resume:** Each entry needs `type`, `message`, `uuid`, `parentUuid`, plus three additional fields: `sessionId`, `cwd`, and `timestamp`. Entries with only `type`/`message`/`uuid`/`parentUuid` fail ("No conversation found"), as does adding `sessionId` alone. The combination of all three additional fields is required. Other metadata (`entrypoint`, `version`, `gitBranch`, `isSidechain`, `permissionMode`, `userType`, `promptId`, `requestId`, `toolUseResult`, `sourceToolAssistantUUID`) is not required. Confirmed via systematic testing across both simple and tool-call conversations (see `packages/backend/scripts/session-store-metadata-test.ts`).

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

Reins now captures the actual compaction summary via a `PostCompact` hook registered on the SDK query. The raw hook output includes an `<analysis>` section (Claude's reasoning) followed by `<summary>` (the actual summary); `extractSummaryContent()` strips the analysis before storing.

### 8. No direct way to disable auto-compaction via SDK

`autoCompactWindow` is a user preference, not an SDK option. Could potentially pass via `extraArgs` if the CLI supports it, but undocumented.

### 9. Custom compaction is stop→rewrite→resume

To do our own compaction: monitor `input_tokens` on each assistant event, call `query.close()` when threshold is hit, rewrite entries in the store, resume with `load()` returning compacted transcript. The model loses in-progress generation but conversation history is preserved.

## Design Decision: load()-only, not persistence

We don't need `SessionStore` for persistence. We already have our own persistence layer (SQLite `session_messages` table) and the SDK writes its own JSONL files to disk. Adding `append()` as a persistence path would mean maintaining two formats and accepting at-most-once delivery semantics for no real benefit.

What we _do_ need is `load()` — the ability to control what the model sees on resume. This is the only part of the `SessionStore` API we should adopt.

### Implementation status

**Built:**
- `toSessionStoreEntries()` translator: `AgentRuntimeMessage[] → SessionStoreEntry[]` with tool name/arg translation, tool result merging, consecutive assistant merging, compaction summary conversion, and UUID chain generation. Fully tested.
- `createSessionStore()` factory: returns a `SessionStore` with `load()` reading from our SQLite via `loadMessagesForLLM()` → `toSessionStoreEntries()`, no-op `append()`, empty `listSubkeys()`. Tested with real DB.
- Verification script (`packages/backend/scripts/session-store-load-test.ts`): end-to-end test that runs a session, persists to our format, and resumes via `load()`.
- Metadata test script (`packages/backend/scripts/session-store-metadata-test.ts`): systematic test of which metadata fields are required for resume.

**Wired up.** The translator and store are complete and connected. `createSessionStore()` is passed into the SDK's `query()` call in `ClaudeSdkAgentRuntime.buildQueryOptions()`. On resume, `load()` reads from our SQLite via `loadMessagesForLLM()` → `toSessionStoreEntries()`. On new sessions, `load()` returns `null` and the SDK starts fresh. `append()` is a no-op — the SDK's local JSONL files handle bookkeeping.

### What this enables

**A. Context pruning via `load()`** (connects to [context-pruning plan](context-pruning.md))

The most compelling use case. `load()` is the insertion point for building a "derived prompt view":

- Strip old tool results, replace with summaries
- Drop attachment entries (skill listings, deferred tool deltas)
- Truncate large assistant responses
- Apply cache-aware pruning (keep full content while cache is warm)

The canonical transcript stays in our database; `load()` returns the pruned version. Pruning operates on our `AgentRuntimeMessage` data before translation to `SessionStoreEntry[]`.

**B. Cross-session context injection**

Fabricate conversation history from other sources — e.g., inject relevant context from previous sessions, documentation, or external knowledge bases as if the model had already seen them.

**C. Capture compaction summaries** ✅

Register a `PostCompact` hook to capture `compact_summary` instead of showing a placeholder. Independent of SessionStore adoption. **Done** — see commit `2fc23d8`.

## Open Questions

1. ~~**How does this interact with our conversation tree model?**~~ Not a concern today — we only support a single linear conversation. If/when we add branching, it would work like compaction: kill the session and `load()` with the selected branch's messages.

2. ~~**Is `@alpha` stability acceptable?**~~ Yes. We only depend on `load()`, and the SDK will always need some way to load conversations — the exact shape may shift but the capability won't disappear.

3. ~~**What's the storage cost of dual-write?**~~ No longer relevant — using the translator approach, no dual-write needed.

## Suggested Next Steps

1. ~~**Immediate (no SessionStore needed):** Register `PostCompact` hook to capture actual compaction summaries.~~ ✅ Done.
2. ~~**Short term:** Add `sessionId`, `cwd`, and `timestamp` parameters to `toSessionStoreEntries()` and include them on each emitted entry.~~ ✅ Done.
3. ~~**Short term:** Wire `sessionStore` into the runtime via `createSessionStore()` — pass it into the SDK's `query()` call.~~ ✅ Done.
4. **Medium term:** Implement context pruning in `load()` — prune `AgentRuntimeMessage[]` before translation, returning a trimmed transcript to the model.

## Test Scripts

- `packages/backend/scripts/session-store-explore.ts` — exploration script that exercises the SessionStore API.
- `packages/backend/scripts/session-store-metadata-test.ts` — systematic test of minimum metadata fields required for resume (9 scenarios, simple + tool-call sessions).
