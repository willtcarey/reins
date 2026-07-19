# Durable Event Streams

Status: **rejected after research** — retained as a historical proposal. See [ADR-007](../../adr/007-durable-stream-protocol.md).

This plan evaluated replacing the fire-and-forget WebSocket event broadcast with persistent, replayable event streams per session using the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol. Reins is not pursuing this direction; the design below records what was considered.

> **Related but independent:** The SDK already emits timing/cost data (`duration_ms`, `duration_api_ms`, `num_turns`, `total_cost_usd`) on every `SDKResultMessage` that we currently discard. Capturing that is a separate quick win — it doesn't depend on durable streams, but once streams exist, the persisted events make it easy to derive granular per-tool timing too. See [SDK research](#sdk-research) for details.

## Implementation plan

### Part 1: Durable stream per session

Each session gets a durable stream backed by SQLite and served at `/api/streams/sessions/{sessionId}`. The stream holds the full sequence of runtime events (deltas) in JSON mode.

**Write side** — in-process, no HTTP. A stream writer observer replaces `runtime-broadcast-observer.ts`:

```ts
function onEvent(event: RuntimeEvent) {
  const rows = db.appendStreamEvents(sessionId, [{ ...event, timestamp: Date.now() }]);
  sseNotifier.notify(sessionId);
}
```

The notify mechanism is in-memory pub/sub (`Map<sessionId, Set<callback>>`) — SSE handlers register listeners; the observer wakes them after each append.

**Read side** — Durable Streams protocol over HTTP, served from the existing Bun server:

| Route | What it does |
|---|---|
| `HEAD /api/streams/sessions/:id` | Returns `Stream-Next-Offset`, `Content-Type`, `Stream-Closed` |
| `GET ...?offset=X` | Catch-up read: events from offset X as JSON array |
| `GET ...?offset=X&live=sse` | SSE tail: catch-up then hold open for live events |

**Frontend** — switches from WebSocket `onmessage` to tailing via `@durable-streams/client`. On reconnect, the client resumes from its last offset — automatic catch-up, no REST reload.

**Stream creation** — visiting a session always opens (or creates) its durable stream. There's no conditional "if stream exists" check. If the session has no stream yet, one is created with its offset initialized from the last persistence checkpoint (or 0 for a brand new session). This means every session always has a stream the frontend can connect to.

**Coordinated reconnect flow:**

1. `GET /sessions/:id/messages` → persisted messages + `persistedStreamOffset`
2. Connect to stream from `persistedStreamOffset` → catch up on events since last persistence checkpoint
3. Tail for live events

| Scenario | What happens |
|---|---|
| Fresh session, actively streaming | No persisted messages, `persistedStreamOffset=0`, stream from beginning — pure delta streaming |
| Reconnect mid-turn | Persisted messages through last `turn_end`, stream picks up in-progress deltas for current turn |
| Revisiting idle/evicted session | Persisted messages are complete, stream is empty (truncated at persist) — nothing to catch up on |
| New tab on active session | Same flow — loads persisted messages, connects to stream, catches up independently |

### Part 2: Timing telemetry tables

At persistence checkpoints (`turn_end`/`agent_end`), the observer reads back stream events for the current turn, computes durations from timestamp pairs, and writes them to SQLite for long-term retention.

| Metric | Source events |
|---|---|
| Tool call duration | `tool_execution_start` → `tool_execution_end` (matching `toolCallId`) |
| Turn duration | `turn_start` → `turn_end` |
| Agent run duration | First `turn_start` → `agent_end` |
| Time-to-first-token | `turn_start` → first `text_delta` |

## What changes, what doesn't

| Component | Today | After |
|---|---|---|
| **Event delivery to frontend** | Broadcast observer → WS `onmessage` | Stream writer observer → SQLite + SSE |
| **Message persistence to SQLite** | Persistence observer → `session_messages` | **Unchanged** |
| **Outbound commands** | WS (prompt, steer, abort) | **Unchanged** |
| **App-level signals** | WS (session_created, task_updated) | **Unchanged** (stay on WS) |
| **Session resume / LLM context** | SQLite `session_messages` | **Unchanged** |
| **REST API** | Session CRUD, projects, settings | **Unchanged** |
| **Runtime adapter contract** | `runtime.subscribe()` | **Unchanged** — the durable stream is an additional consumer, parallel to the persistence observer |

## Architecture

```
Runtime events ──→ runtime.subscribe()
                        │
                ┌───────┴───────────────┐
                │                       │
        Stream writer               Persistence observer
        observer                    (snapshots messages to SQLite)
                │                       │
                ▼                       │  on turn_end / agent_end:
        SQLite stream_events            │  1. persist messages
        + notify waiting SSE            │  2. record current stream offset
                │                       │  3. truncate stream events ≤ offset
        ┌───────┴───────┐              │
        │               │              ▼
   Frontend tab 1   Frontend tab 2   stream_metadata.persisted_offset
   (SSE, offset=N)  (SSE, offset=M)
```

### Stream storage schema

```sql
CREATE TABLE stream_events (
  stream_id TEXT NOT NULL,          -- session ID
  seq INTEGER NOT NULL,             -- auto-increment within stream
  offset TEXT NOT NULL,             -- zero-padded seq, e.g. "00000000000042"
  data TEXT NOT NULL,               -- JSON event payload
  created_at INTEGER NOT NULL,      -- epoch ms
  PRIMARY KEY (stream_id, seq)
);

CREATE TABLE stream_metadata (
  stream_id TEXT PRIMARY KEY,       -- session ID
  content_type TEXT NOT NULL DEFAULT 'application/json',
  closed INTEGER NOT NULL DEFAULT 0,
  persisted_offset TEXT,            -- offset through which messages are persisted to SQLite
  created_at INTEGER NOT NULL       -- epoch ms
);

CREATE INDEX idx_stream_events_offset ON stream_events(stream_id, offset);
```

Offsets are zero-padded to 14 digits (~100 trillion events per stream). The offset column is redundant with seq but makes protocol-compatible queries simple: `WHERE stream_id = ? AND offset > ? ORDER BY offset LIMIT ?`.

### Telemetry schema

```sql
CREATE TABLE turn_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL,        -- epoch ms
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  time_to_first_token_ms INTEGER,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tool_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,        -- epoch ms
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  is_error BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_turn_telemetry_session ON turn_telemetry(session_id);
CREATE INDEX idx_tool_telemetry_session ON tool_telemetry(session_id);
CREATE INDEX idx_tool_telemetry_turn ON tool_telemetry(session_id, turn_seq);
```

### Stream event example

```json
[
  {"type":"turn_start","timestamp":1714052400000},
  {"type":"text_delta","text":"Let me ","timestamp":1714052400050},
  {"type":"text_delta","text":"check that.","timestamp":1714052400100},
  {"type":"tool_execution_start","toolCallId":"abc","toolName":"bash","timestamp":1714052400200},
  {"type":"tool_execution_end","toolCallId":"abc","toolName":"bash","timestamp":1714052403700},
  {"type":"turn_end","timestamp":1714052403800}
]
```

### Stream lifecycle and truncation

One stream per session, for the session's entire lifetime. Visiting a session always ensures its stream exists. The stream goes quiet between prompts — no EOF on eviction. EOF only on permanent session deletion.

**Truncation on persist:** When the persistence observer checkpoints messages to SQLite (`turn_end`/`agent_end`/`compaction_end`), it also:
1. Records the current stream tail offset as `persisted_offset` in `stream_metadata`
2. Deletes all `stream_events` rows at or before that offset

This means the stream only holds events since the last persistence checkpoint — typically just the in-progress turn. Persisted messages in SQLite are the long-term store; the stream is a buffer for what hasn't been persisted yet.

| Session state | Stream state | Stream contents |
|---|---|---|
| **Created / visited** | Created (or already exists) | Empty — `persisted_offset` = 0 |
| **Active** | Events appending, clients tailing | Growing — events since last persist |
| **Persist checkpoint** | Truncated | Shrinks to 0 — everything now in SQLite |
| **Mid-turn** | Events appending | Only current turn's deltas |
| **Idle / evicted** | Open, empty, readable | Nothing to catch up on — SQLite is complete |
| **Resumed** | Appends resume | New events accumulate until next persist |

Key points:
- **Stream is always available.** Visiting a session ensures the stream exists. No 404s, no conditional creation.
- **Bounded storage.** Stream only holds events between persistence checkpoints — usually one turn's worth. No unbounded growth, no TTL expiry to manage.
- **Never EOF except on session deletion.** Durable Streams EOF is permanent and irreversible — incompatible with session resume. The stream just goes empty and quiet.
- **Multi-window support.** Multiple clients read independently with their own offsets.
- **Graceful reconnect.** If a client reconnects and its offset has been truncated, it loads persisted messages from SQLite and connects to the stream from the current `persisted_offset` — same as the normal reconnect flow.
- **Delegate sub-sessions** get their own independent streams, same truncation policy.

### Protocol surface

**Implemented:**
- Response headers: `Stream-Next-Offset`, `Stream-Up-To-Date`, `Stream-Closed`, `Content-Type: application/json`
- SSE format: `event: data` with JSON arrays, `event: control` with `streamNextOffset` / `upToDate` / `streamClosed`
- JSON mode: results wrapped in arrays on read
- Offsets: zero-padded integers from SQLite `seq` column (opaque, lexicographically sortable)
- `offset=-1` (stream beginning) and `offset=now` (current tail) sentinel values

**Skipped** (not needed for single-process, single-writer, local use):
- PUT/POST routes (writes are in-process function calls)
- Idempotent producer validation (`Producer-Id`, `Producer-Epoch`, `Producer-Seq`)
- `Stream-Seq` writer coordination
- Content-type mismatch checking (all streams are `application/json`)
- Fork creation and stitching (future option)
- CDN cursor collapsing (no CDN; return dummy cursor)
- ETag / `If-None-Match` (can add later)
- Long-poll mode (SSE is sufficient; can add later)

## Problem

REINS broadcasts runtime events over WebSocket in real time. This works well for live streaming, but the broadcast is fire-and-forget — once an event is sent, it's gone.

1. **Reconnect fragility** — on disconnect, the frontend misses delta events. Reconnect does a full REST reload of persisted messages, causing a jarring jump. Events between the last persistence checkpoint and disconnect are lost.

2. **No post-hoc timing visibility** — tool durations, turn durations, and model latency are observable only in real time. No way to answer "how long did that bash call take?" after the fact.

3. **Multi-tab / multi-device gaps** — every tab receives a firehose of all sessions' events with no per-session offset tracking. A backgrounded tab can't catch up without a full reload.

4. **Compaction history loss** — `pruneToolResultsBeforeSeq` permanently replaces pre-compaction tool results with `[pruned]`. The original content is unrecoverable.

## SDK research

### What the SDK provides

**Timing data on `SDKResultMessage`** (end of each prompt):
- `duration_ms` — wall-clock duration of the full agent loop
- `duration_api_ms` — time spent waiting on API calls only
- `num_turns` — internal tool-use turns

**Timing data on `SDKToolProgressMessage`** (during tool execution):
- `elapsed_time_seconds` — current tool runtime

**Timing on `SDKTaskNotificationMessage` / `SDKTaskProgressMessage`:**
- `usage.duration_ms` — task duration

**Cost data on `SDKResultMessage`:**
- `total_cost_usd`, `usage` (aggregate tokens), `modelUsage` (per-model breakdown)

**Session persistence via `SessionStore` adapter:**
The SDK supports a `SessionStore` interface for mirroring transcripts to an external store. REINS already implements this. The SDK writes locally first, then calls `append()` with `SessionStoreEntry[]` batches at ~100ms cadence. This is a transcript mirror, not an event stream.

### What the SDK does NOT provide

- No built-in event persistence or replay. Streaming output is ephemeral.
- No durable stream primitive. `stream()` is a one-shot `AsyncGenerator`.
- No offset-based resume. If you stop consuming, events are lost.
- `otelHeadersHelper` is just a script path for OTel headers on API calls — no built-in telemetry collection.

**Conclusion:** the SDK gives us good per-prompt timing and cost aggregates that we should capture separately, but it doesn't solve real-time event durability. We need our own solution for that.

### Why not use existing Durable Streams server implementations?

Both the Node.js reference server and Caddy plugin run their own HTTP server on a separate port, use LMDB (native addon, risky on Bun), and add a second storage engine alongside SQLite. The write side is designed for external HTTP producers — but in REINS, the writer is the in-process observer.

**Decision:** implement only the read side of the protocol as route handlers in the existing Bun server, backed by SQLite. Writes are direct function calls. The frontend uses `@durable-streams/client` which only needs the read path (GET/HEAD).

## Resolved questions

- **Embedded vs. sidecar server** → Neither. Read-side protocol only, in the existing Bun server.
- **Stream granularity** → One stream per session. Delegate sub-sessions get their own independent streams.
- **Stream creation** → Always. Visiting a session ensures its stream exists. No conditional logic, no 404s.
- **Stream retention** → Truncate on persist, not TTL. The persistence observer records its stream offset and deletes everything at or before it. The stream is a buffer for unpersisted events, not a long-lived archive.
- **Migration** → Existing sessions treated as having 0 stream events. Frontend loads from DB as usual; stream returns empty array with `Stream-Up-To-Date: true`.
- **Frontend complexity** → WebSocket carries app-level signals (session_created, task_updated). Durable stream carries runtime deltas. Clean separation by purpose.
