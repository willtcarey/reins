# Runtime event contract

## Purpose

This document defines the normalized backend contracts for WebSocket streaming and session lifecycle. Runtime adapters explicitly map native events; vendor events are not passed through unchecked.

Only the AgentHarness Pi adapter is registered. Imported Claude sessions are converted to canonical Pi storage before they can be opened, so active runtime and frontend code do not maintain a legacy transcript protocol.

## Event surface

Runtimes publish events through `AgentRuntime.subscribe(listener)`. Reins broadcasts them as:

- `{ type: "event", sessionId, projectId, event }`

Every durable chat insertion is an `entry_added` event containing the canonical `ConversationEntry` envelope also returned by message pages:

- `id`: AgentHarness entry ID
- `parentId`: AgentHarness parent entry ID
- `seq`: AgentHarness sequence
- `clientId`: Reins submission ID for a `reinsInput` entry, when applicable
- `message`: the content-only runtime projection

The frontend upserts pages and events by `id`. It resolves an optimistic input only when the canonical entry has the same `clientId`. There is no separate peer-input broadcast, transcript fallback, FIFO matching, or timestamp matching.

## Streaming semantics

Each `message_start`, `message_update`, and `message_end` event carries a required `streamId`. An adapter must preserve that identity for the complete message lifecycle. `message_end` includes `entryId` when the native event exposes the corresponding durable entry, allowing the frontend to remove exactly that streaming overlay when its canonical entry arrives.

Streaming messages are presentation overlays only. They never become persisted conversation entries by inference. `agent_end` clears remaining overlays and reports terminal errors, but does not promote `agent_end.messages` into conversation history. Compaction summaries likewise appear only through canonical `entry_added` events.

## Context occupancy semantics

Context occupancy is a canonical REST projection, not a runtime event. The session context resource reads the active `main` branch and uses usage embedded in the latest valid assistant message with AgentHarness's `estimateContextTokens` semantics. This naturally excludes standalone structural requests such as compaction summaries and never substitutes cumulative session statistics for current occupancy.

Existing durable event boundaries invalidate the frontend snapshot: canonical `entry_added` events and `compaction_end` schedule a refresh, while `compaction_start` makes the previous measurement unknown. Refresh, reconnect, and model changes use the same resource. The projection estimates messages after the latest provider measurement and replacement context after compaction. The runtime exposes only whether live compaction currently invalidates the canonical measurement; request generations prevent an older response from restoring stale exact data.

## Lifecycle semantics

Each runtime receives a `RuntimeLifecycleSink` when it is constructed. The AgentHarness runtime listens to native events internally and calls:

- `started()` for `run_start`, `run_resume`, and `compaction_start`;
- `settled(runtime, outcome)` for durable `run_end`.

`compaction_end` is intentionally not a settlement boundary because automatic compaction can precede the terminal run transaction. AgentHarness emits `run_end` after retries, deferred polling, steering, and automatic compaction. The runtime does not expose a second lifecycle event stream.

`agent_end` includes:

- `runId`: native run/operation identity
- `status`: `completed`, `failed`, or `aborted`
- `error`: structured native failure information when failed
- `messages`: messages produced during this run, used for terminal diagnostics rather than transcript insertion

Consumers use terminal `status` and `error` instead of inferring operation state from transcript contents.

## Persistence and reporting

Canonical AgentHarness transcript entries are committed directly through `PiStorageAdapter`; runtime events do not trigger transcript snapshot writes.

The injected caller-scoped `SessionInstance` applies settlement effects in order:

1. persist final model/thinking metadata;
2. set `activity_state = 'finished'` and broadcast the session update;
3. asynchronously report a child's authoritative outcome and latest result text to its parent.

It sets `activity_state = 'running'` when the runtime calls `started()`. A native `run_end` callback may occur just before Reins removes its local active-operation bookkeeping; this local cleanup gap is not a second runtime lifecycle phase.

## Tool event contract

For useful tool rendering, adapters emit:

- `tool_execution_start` with stable `toolCallId`, `toolName`, and `args`
- `tool_execution_update` when progress is available
- `tool_execution_end` with the same ID/name, optional `result`, and `isError`

Tool names should be normalized to canonical Reins names where feasible.

## Adapter mapping rules

Runtime adapters must:

1. Consume native operation boundaries internally and notify the injected `RuntimeLifecycleSink`.
2. Explicitly map rich native events to `AgentRuntimeEvent`.
3. Map the native durable terminal event to both sink `settled()` and UI `agent_end` exactly once.
4. Preserve native terminal identity, status, and error in both projections.
5. Emit canonical `ConversationEntry` envelopes for durable entries.
6. Assign every active message lifecycle a stable, explicit `streamId`.
7. Normalize compaction UI events without treating `compaction_end` as terminal activity.
8. Keep tool-call IDs stable across tool events.
9. Keep runtime-specific extra fields additive.
