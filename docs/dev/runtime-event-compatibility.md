# Runtime Event Compatibility Contract

## Purpose

This document defines the backend contract that all agent runtimes must satisfy for:

- WebSocket event streaming
- Session persistence
- Session metadata updates

Reins uses the pi `AgentSessionEvent` shape as the current wire format.
This is a **structural data contract** only.

## Event surface

Runtimes publish events through `AgentRuntime.subscribe(listener)`.

Reins broadcasts events to clients with this envelope:

- `{ type: "event", sessionId, projectId, event }`

Compaction uses these broadcast event types:

- `compaction_start`
- `compaction_end`

## Required event semantics

Runtimes must emit events that provide these semantics:

1. `turn_end`
   - A turn completed and message state is checkpointable.

2. `agent_end`
   - A run completed and final state is available.

3. `compaction_end` (or runtime-native equivalent normalized to this)
   - A compaction attempt finished.
   - `aborted: true` means compaction did not commit.

## Persistence contract

Persistence is event-driven by runtime events.

Reins persists messages when it observes:

- `turn_end`
- `agent_end`
- `compaction_end` when `aborted !== true`

Reins does not persist on aborted compaction.

On `agent_end`, Reins may also update session metadata (`model_provider`, `model_id`, `thinking_level`) from `runtime.getSessionMetadata()` when available.

## Tool event contract

For streaming UI compatibility, runtimes should emit:

- `tool_execution_start` with:
  - `toolCallId` (required, stable)
  - `toolName`
  - `args`
- `tool_execution_end` with:
  - same `toolCallId`
  - `toolName`
  - optional `result`
  - optional `isError`

Tool names should be normalized to canonical Reins names where feasible.

## Adapter mapping rules

Runtime adapters should:

1. Map runtime-native lifecycle events to required semantics.
2. Normalize compaction events to `compaction_start` / `compaction_end` for broadcast.
3. Keep `toolCallId` stable across tool start/end.
4. Normalize tool names to Reins canonical names when possible.
5. Include `agent_end.messages` when available (recommended for frontend correctness).
6. Keep runtime-specific extra fields additive.
