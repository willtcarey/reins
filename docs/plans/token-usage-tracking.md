# Token Usage Tracking

Track per-turn token usage and cost across both runtimes so we can display aggregate stats and charts in the UI.

## Current State

Neither runtime captures token/cost data. Messages stored in `session_messages` contain no usage fields. Both upstream SDKs expose usage data, but we discard it.

### What the SDKs provide

**Claude Agent SDK** — `SDKResultMessage` (emitted at end of each prompt turn):
- `total_cost_usd: number`
- `usage: NonNullableUsage` — aggregate `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- `modelUsage: Record<string, ModelUsage>` — per-model breakdown with `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`, `webSearchRequests`
- `duration_ms`, `duration_api_ms`, `num_turns`

**PI SDK** — `AgentSession.SessionStats`:
- `tokens: { input, output, cacheRead, cacheWrite, total }`
- `cost: number`
- These are running totals on the session, not per-turn deltas.

## Schema

New `token_usage` table — one row per turn/prompt completion:

```sql
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  model_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_token_usage_session ON token_usage(session_id);
CREATE INDEX idx_token_usage_created ON token_usage(created_at);
```

A dedicated table (vs. columns on `session_messages` or `sessions`) keeps queries simple for charting — sum by day, by model, by session, by project — without parsing message JSON. It also decouples usage tracking from message persistence.

## Capture Points

### Claude Agent SDK

The stream processor (`stream-processor.ts`) already handles `SDKMessage` events. When we see a `SDKResultMessage` (type `result`, subtype `success` or `error`), insert a row using `usage` and `total_cost_usd`. The `modelUsage` record gives per-model breakdown if we want to split by model.

### PI Runtime

The PI runtime subscribes to session events in `runtime.ts`. Listen for `turn_end` events. Since `SessionStats` provides running totals rather than per-turn deltas, keep a snapshot of the previous totals and diff on each `turn_end`.

### Shared Interface

Add an `AgentRuntimeEvent` variant for usage so the capture logic can live in a single observer:

```ts
| { type: "usage"; sessionId: string; modelId?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number; durationMs?: number }
```

Each runtime adapter emits this event, and a new `RuntimeUsageObserver` (or an addition to `RuntimePersistenceObserver`) inserts the row.

## Query Layer

Add functions to a `usage-store.ts`:

- `getSessionUsage(sessionId)` — totals for a single session
- `getProjectUsage(projectId, dateRange?)` — totals across sessions in a project
- `getUsageTimeSeries(projectId, granularity, dateRange?)` — grouped by day/week for charts
- `getUsageByModel(projectId, dateRange?)` — breakdown by model

These join through `sessions` to get the `project_id` link.

## Frontend

TBD — likely a usage/stats page or dashboard panel with charts. The query layer should support whatever granularity the UI needs.

## Open Questions

- Do we want to backfill from existing Claude SDK session logs, or only track going forward?
- Should we store web search request counts (available from Claude SDK `modelUsage`)?
- Do we need per-API-call granularity (from `BetaMessage.usage` on each `SDKAssistantMessage`), or is per-turn sufficient?
