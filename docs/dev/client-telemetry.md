# Client Diagnostic Telemetry

Reins has a development-only structured telemetry path for diagnosing timing-sensitive browser behavior that is difficult to reproduce from tests. It runs inside the existing backend; no collector or additional service is required.

## Capture a reproduction

Telemetry runs automatically in development builds, including browsers on other devices such as phones. There is no per-browser flag to enable and no reload is required before reproducing a problem. One `runId` identifies the lifetime of a loaded SPA page, while separately correlated operations such as each review file-tree navigation receive their own `operationId`.

Production frontend builds do not record telemetry, and the backend registers the ingestion endpoint only when `REINS_DEV=1`.

## Read and clear logs

The backend writes NDJSON to the operating-system temporary directory:

```text
/tmp/reins-client-telemetry.jsonl
/tmp/reins-client-telemetry.jsonl.1
/tmp/reins-client-telemetry.jsonl.2
/tmp/reins-client-telemetry.jsonl.3
```

Inspect the current and rotated files with:

```bash
ls -lh /tmp/reins-client-telemetry.jsonl*
tail -n 100 /tmp/reins-client-telemetry.jsonl
jq -c 'select(.scope == "review-virtualizer")' /tmp/reins-client-telemetry.jsonl*
```

Start with a clean capture by removing all generations:

```bash
rm -f /tmp/reins-client-telemetry.jsonl*
```

Each file is capped at 1 MiB and only four generations, including the current file, are retained. The browser queue is capped at 500 events, requests contain at most 100 events, and the endpoint also limits request and individual-event sizes. These are hard bounds intended to prevent an abandoned diagnostic capture from consuming unbounded memory or disk.

## Event format

Events follow a small OpenTelemetry-inspired shape:

```json
{
  "receivedAt": "2026-08-19T15:04:05.200Z",
  "timestamp": "2026-08-19T15:04:05.123Z",
  "runId": "b7429f25-4dd5-47d7-a8d8-58cb168d56eb",
  "sequence": 42,
  "scope": "review-virtualizer",
  "event": "geometry-applied",
  "attributes": {
    "requestedTop": 4200,
    "actualBefore": 3980,
    "actualAfter": 3980,
    "layoutVersion": 17,
    "operationId": "review-virtualizer-3"
  }
}
```

`runId` groups one page lifetime, while `sequence` preserves browser emission order. `operationId` correlates events belonging to one interaction without requiring a page reload; the review virtualizer starts a new operation for every file-tree navigation. `receivedAt` is added by the backend. The review virtualizer records navigation, scrolling, measurement batches, geometry corrections, cancellation, and mounted-window changes.

## Diff renderer failure capture

After installing instrumentation, refresh the browser once, then reproduce repeated Changes updates. Existing tabs cannot report failures retroactively. Filter the current and rotated logs with:

```bash
jq -c 'select(.scope == "review-renderer")' /tmp/reins-client-telemetry.jsonl*
```

The review adapter hooks Pierre's asynchronous highlight-error handler and records `review-renderer` / `failed` with partial/full state, line-array lengths, hunk count, and expansion count, then attempts an immediate flush through the existing bounded queue. Use `runId` and `sequence` to locate the failure among other page events.

The known `DiffHunksRenderer.processDiffResult` null-line assertion is classified as `null-diff-lines`; other errors are classified as `other`. Raw error messages, stacks, paths, cache keys, and source contents are not exported. Pierre's original error handler still runs, so failures retain their existing console behavior. This diagnostic-only hook does not retry or recover.

## Live streaming capture

The `streaming` scope measures the cost of live assistant output (`message_update` / `tool_execution_update`). Per-token work is aggregated in memory by `models/streaming-telemetry.ts` and exported as at most one `streaming` / `window` event per second while something is streaming, never one event per token. Nothing is recorded, and no timers run, when telemetry is disabled.

```bash
jq -c 'select(.scope == "streaming") | .attributes' /tmp/reins-client-telemetry.jsonl*
```

Each window reports:

| Attribute | Meaning |
|---|---|
| `windowMs` | Time the window covered. |
| `streamId`, `streamIds`, `streamCount` | The first stream seen, up to four stream IDs (comma-separated), and how many streams were active. |
| `events`, `frames`, `maxEventsPerFrame` | Streaming partials applied for viewed sessions, frame-batched listener notifications, and the largest batch. Unviewed sessions do not notify and are not counted. |
| `receiptToPaint{Count,MeanMs,MaxMs}` | From when `ConversationsStore` applied the first event of a batch (immediately after the WebSocket frame is parsed) to a task queued after that frame's notification, which approximates paint. |
| `panelRender{Count,MeanMs,MaxMs}` | Synchronous `chat-panel` update duration while streaming messages are shown. Child elements such as `<markdown-content>` update in their own cycles and are measured separately. |
| `markdownParse{Count,MeanMs,MaxMs}` | Streaming `<markdown-content>` render work: settled-prefix scan plus parsing of any newly settled segment and the live tail. |
| `markdownTextLengthMax`, `markdownParsedLengthMax` | Largest streaming message text, and the most characters parsed in one render. With the settled-prefix split the parsed length should stay near the tail size, not the message size. |
| `socketEvents`, `socketBytes` | Session event frames the WebSocket delivered, for any session (viewed or not), and their size. |
| `socketGap{Count,MeanMs,MaxMs}`, `socketBurstMax` | Time between consecutive event frames arriving, and the longest run of frames at most 4ms apart. A long burst after a long gap means frames were held up before the browser. |
| `socketHandle{Count,MeanMs,MaxMs}` | `JSON.parse` plus synchronous dispatch into the stores, per frame. |
| `emitToHandled{Count,MeanMs,MaxMs}` | Browser wall clock after handling minus the node's `emittedAt`: end-to-end latency. Only meaningful when node and browser clocks agree (same machine). |
| `longTask{Count,MeanMs,MaxMs}` | Main-thread long tasks (`PerformanceObserver` `longtask`, ≥50ms) while a window is open. Stalls here with small component timings point at GC, layout or unrelated work. |

To compare changes, clear the logs, stream a long assistant message in a long session, and compare the windows from the middle of the stream.

## Session bus capture

The server writes its own `session-bus` scope into the same log, through `serverTelemetry` (same record envelope, `runId` prefixed `server-`), when `REINS_DEV=1`: one `window` record per second while node session events are being relayed. Every `session.event` carries the node's `emittedAt` (wall clock at emission), which the server forwards to browsers in the `event` frame.

```bash
jq -c 'select(.scope == "session-bus" or .scope == "streaming") | [.scope, .receivedAt // .timestamp, .attributes]' /tmp/reins-client-telemetry.jsonl*
```

| Attribute | Meaning |
|---|---|
| `windowMs`, `sessions`, `events`, `bytes` | Window length, distinct sessions, relayed events and their serialized size. |
| `missed` | Seq gaps the server saw (events the node emitted that never arrived). |
| `clientsMax` | Connected browsers each frame was sent to. |
| `emitGap{Count,MeanMs,MaxMs}`, `emitBurstMax` | Per-session spacing of the node's `emittedAt`, and the longest run ≤4ms apart. Bursts here left the node bunched: Pi or the provider stream. |
| `arrivalGap{Count,MeanMs,MaxMs}`, `arrivalBurstMax` | The same for server receipt time. Arrival bursts without matching emission bursts were bunched in transit (the node's event loop, the socket, or the server's event loop). |
| `transit{Count,MeanMs,MaxMs}`, `transitSlowCount` | Server wall clock at receipt minus `emittedAt`, and how many exceeded 50ms. |
| `relay{Count,MeanMs,MaxMs}` | Server handling from receipt to having sent the frame to every browser. |

Reading a hitch across hops: `emitBurstMax` high → upstream; `arrivalBurstMax` high with even emission → node→server transport or a blocked server; `socketBurstMax` high with even server arrival → server→browser; even socket arrival but high `receiptToPaint`/`longTask` → browser rendering.

## Adding instrumentation

Use the shared bounded recorder:

```ts
import { clientTelemetry } from "../models/client-telemetry.js";

clientTelemetry.record("my-scope", "operation-completed", {
  durationMs,
  itemCount,
});
```

The recorder owns error isolation: `record()` (including operation recording and lazy attribute callbacks) never throws, and `flush()` never rejects. Failed attribute/timestamp evaluation drops that event; failed enablement behaves as disabled; transport failures retain the bounded queue for a later flush. Callers should not wrap telemetry in defensive `try/catch` or attach rejection handlers. Use lazy attribute callbacks for diagnostic computations that might throw, since ordinary argument evaluation happens before the recorder is called.

Prefer stable event names and scalar diagnostic attributes. Record requested and observed values separately when investigating synchronization problems.

High-frequency measurements (per token, per frame, per relayed event) must not become one record each. Aggregate them into windows with `TelemetryWindow` and the `Stat`/`Cadence` helpers from `@reins/telemetry`, and export one record per window through a recorder, as `streaming-telemetry.ts` and `session-bus-telemetry.ts` do. Server-side diagnostics record through `serverTelemetry` (`packages/backend/src/models/server-telemetry.ts`), the server's counterpart of `clientTelemetry`.

Never record source text, diff contents, prompts, credentials, cookies, authorization headers, full file paths, or unrestricted console arguments. Use indexes, counts, booleans, durations, and geometry instead. Telemetry is a diagnostic aid, not application state or an audit log.

## Implementation

- `packages/telemetry` (`@reins/telemetry`, no dependencies, so both the browser bundle and the server take it) holds what both sides share: the record envelope (`TelemetryEvent`), the `TelemetryRecorder` interface, and window aggregation (`TelemetryWindow`, `Stat`, `statAttributes`, `Cadence` with the 4ms burst gap).
- `packages/frontend/src/models/client-telemetry.ts` owns enablement, run correlation, bounded buffering, batching, and transport.
- `packages/frontend/src/models/streaming-telemetry.ts` aggregates the `streaming` scope into per-second windows; `ConversationsStore`, `chat-panel`, and `<markdown-content>` feed it.
- `packages/backend/src/routes/client-telemetry.ts` validates batches and exposes `POST /api/diagnostics/client-events` in development.
- `packages/backend/src/models/client-telemetry-log.ts` serializes writes, owns bounded JSONL rotation and holds the shared `clientTelemetryLog`.
- `packages/backend/src/models/server-telemetry.ts` is the server's recorder: the same envelope under one `server-` run per process, appended to `clientTelemetryLog`.
- `packages/backend/src/models/session-bus-telemetry.ts` aggregates the `session-bus` scope; `runtimes/node-session-events.ts` feeds it on every relayed event. The node stamps `emittedAt` in `packages/node/src/node.ts`.
