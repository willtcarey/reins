# Runtime Event Compatibility Contract

## Purpose

This document defines the normalized backend contracts for WebSocket streaming and session lifecycle. Runtime adapters explicitly map native events; vendor events are not passed through unchecked.

Only the AgentHarness Pi adapter is currently registered.

## Event surface

Runtimes publish events through `AgentRuntime.subscribe(listener)`. Reins broadcasts them as:

- `{ type: "event", sessionId, projectId, event }`

This rich event stream is a frontend compatibility surface. Application lifecycle effects do not infer operation state from it.

## Lifecycle semantics

Each runtime receives a `RuntimeLifecycleSink` when it is constructed. The AgentHarness runtime listens to its native events internally and calls:

- `started()` for `run_start`, `run_resume`, and `compaction_start`;
- `settled(runtime, outcome)` for durable `run_end`.

`compaction_end` is intentionally not a settlement boundary because automatic compaction can precede the terminal run transaction. AgentHarness emits `run_end` after retries, deferred polling, steering, and automatic compaction. The runtime does not expose a second lifecycle event stream.

When the native runtime provides it, `agent_end` includes:

- `runId`: native run/operation identity
- `status`: `completed`, `failed`, or `aborted`
- `error`: structured native failure information
- `messages`: messages produced during this run

Consumers should use terminal `status` and `error` instead of inferring an outcome from the last assistant message. Adapters without authoritative outcome fields may omit them, preserving transcript inference as a compatibility fallback.

## Persistence and reporting

Canonical AgentHarness transcript entries are committed directly through `PiStorageAdapter`; runtime events do not trigger transcript snapshot writes.

The injected `SessionRuntimeLifecycle` applies settlement effects in order:

1. persist final model/thinking metadata;
2. set `activity_state = 'finished'` and broadcast the session update;
3. asynchronously report a child's authoritative outcome and latest result text to its parent.

It sets `activity_state = 'running'` when the runtime calls `started()`. A native `run_end` callback may occur just before Reins removes its local active-operation bookkeeping; this local cleanup gap is not a second runtime lifecycle phase.

## Frontend behavior

The raw normalized events remain broadcast for streaming compatibility. The frontend treats `agent_end` as both final-message promotion and stream-finalization for that run. It prefers `agent_end.error.message` for user-facing terminal errors, falling back to an assistant error message only when authoritative outcome data is absent.

Frontend conversation handling ignores `role: "user"` entries in `agent_end.messages`; visible user text comes from optimistic local entries, peer `user_message` events, and persisted projections.

## Tool event contract

For useful tool rendering, adapters should emit:

- `tool_execution_start` with stable `toolCallId`, `toolName`, and `args`
- `tool_execution_update` when progress is available
- `tool_execution_end` with the same ID/name, optional `result`, and `isError`

Tool names should be normalized to canonical Reins names where feasible.

## Adapter mapping rules

Runtime adapters should:

1. Consume native operation boundaries internally and notify the injected `RuntimeLifecycleSink`.
2. Explicitly map rich native events to `AgentRuntimeEvent` for frontend compatibility.
3. Map the native durable terminal event to both sink `settled()` and UI `agent_end` exactly once.
4. Preserve native terminal identity, status, and error in both projections.
5. Normalize compaction UI events without treating `compaction_end` as terminal activity.
6. Keep tool-call IDs stable across tool events.
7. Include run-local `agent_end.messages` when available.
8. Keep runtime-specific extra fields additive.
