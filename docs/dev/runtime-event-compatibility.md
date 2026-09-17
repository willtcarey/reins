# Runtime Event Compatibility Contract

## Purpose

This document defines the normalized backend contract used for WebSocket streaming, session lifecycle state, and runtime metadata updates. Runtime adapters explicitly map native events to `AgentRuntimeEvent`; vendor events are not passed through unchecked.

Only the AgentHarness Pi adapter is currently registered.

## Event surface

Runtimes publish events through `AgentRuntime.subscribe(listener)`. Reins broadcasts them as:

- `{ type: "event", sessionId, projectId, event }`

The terminal activity event is `agent_end`. There is no separate normalized settlement event or runtime-selected completion boundary.

## Lifecycle semantics

- `agent_start` marks runtime work as running.
- `compaction_start` also marks runtime work as running; it need not be nested under an already observed `agent_start`.
- `compaction_end` reports compaction completion but does not finish session activity.
- `agent_end` marks the complete runtime operation finished.

AgentHarness 0.85.1 emits native `run_end` from the durable terminal transaction, after retries, deferred polling, steering, and automatic compaction. The Pi adapter therefore maps `run_end` directly to `agent_end`; it does not synthesize a later event after Reins removes the operation from its local `activeOperations` map.

When the native runtime provides it, `agent_end` includes:

- `runId`: native run/operation identity
- `status`: `completed`, `failed`, or `aborted`
- `error`: structured native failure information
- `messages`: messages produced during this run

Consumers should use terminal `status` and `error` instead of inferring an outcome from the last assistant message. Adapters without authoritative outcome fields may omit them, preserving transcript inference as a compatibility fallback.

## Persistence and reporting

Canonical AgentHarness transcript entries are committed directly through `PiStorageAdapter`; runtime events do not trigger transcript snapshot writes.

The synchronous lifecycle observer:

- sets `activity_state = 'running'` on `agent_start` and `compaction_start`
- persists final metadata and sets `activity_state = 'finished'` on `agent_end`

The parent-report observer is subscribed after the lifecycle observer and also reacts to `agent_end`, reporting the authoritative terminal status/error plus the latest result text. A native `run_end` callback may occur just before Reins removes its local active-operation bookkeeping; this local cleanup gap is not a second runtime lifecycle phase.

On `agent_end`, Reins may update `model_provider`, `model_id`, and `thinking_level` from `runtime.getSessionMetadata()`.

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

1. Explicitly map native lifecycle events to the typed normalized contract.
2. Map the native durable terminal event to `agent_end` exactly once.
3. Preserve native terminal identity, status, and error when available.
4. Normalize compaction events to `compaction_start` / `compaction_end` without treating them as terminal activity.
5. Keep tool-call IDs stable across tool events.
6. Include run-local `agent_end.messages` when available.
7. Keep runtime-specific extra fields additive.
