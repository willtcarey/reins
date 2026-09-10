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

A catch around the review adapter's `renderer.render` call records `review-renderer` / `failed` with partial/full state, line-array lengths, hunk count, and expansion count, then attempts an immediate flush through the existing bounded queue. Use `runId` and `sequence` to locate the failure among other page events.

The known `DiffHunksRenderer.processDiffResult` null-line assertion is classified as `null-diff-lines`; other errors are classified as `other`. Raw error messages, stacks, paths, cache keys, and source contents are not exported. Errors are rethrown unchanged: this diagnostic-only pass does not retry or recover. It does not intercept later asynchronous worker errors, hydration rejections, or interaction-triggered rerenders. Save the browser console stack for those failures.

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

Never record source text, diff contents, prompts, credentials, cookies, authorization headers, full file paths, or unrestricted console arguments. Use indexes, counts, booleans, durations, and geometry instead. Telemetry is a diagnostic aid, not application state or an audit log.

## Implementation

- `packages/frontend/src/models/client-telemetry.ts` owns enablement, run correlation, bounded buffering, batching, and transport.
- `packages/backend/src/routes/client-telemetry.ts` validates batches and exposes `POST /api/diagnostics/client-events` in development.
- `packages/backend/src/models/client-telemetry-log.ts` serializes writes and owns bounded JSONL rotation.
