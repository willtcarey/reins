# AgentHarness Pi Runtime Event Ordering

## Current adapter

The registered Pi runtime uses AgentHarness 0.85.1. Reins maps AgentHarness events to its normalized runtime contract; it no longer exposes the earlier `AgentSession` lifecycle as the current adapter contract.

## Terminal boundary

AgentHarness emits `run_end` from the durable terminal commit after all operation-owned work has resolved, including:

- provider retries
- deferred response polling
- accepted steering
- automatic compaction

The runtime calls its injected lifecycle sink's `settled()` method for application effects and projects normalized `agent_end` for frontend compatibility. Both represent the same native boundary.

There is no later synthetic settlement boundary or `AgentRuntime.activityCompletionBoundary` capability. Waiting for Reins to delete the operation from its local `activeOperations` map after `lane.drive()` returns would only observe local bookkeeping, not additional AgentHarness work or persistence.

A handler invoked for native `run_end` can still observe `runtime.isStreaming() === true` during the callback because local operation cleanup follows event delivery. Application effects run through the lifecycle sink; frontend consumers use `agent_end`. Neither should derive the lifecycle boundary from that callback-time local flag. APIs such as `waitForIdle()` continue to wait through local cleanup before resolving.

## Representative ordering

A simple completed operation is normalized as:

```text
agent_start
→ turn_start
→ message_start/update/end
→ turn_end
→ agent_end(status=completed)
```

Automatic compaction is part of the same AgentHarness operation and precedes its durable terminal event:

```text
agent_start
→ ... turn/message events ...
→ compaction_start
→ compaction_end
→ agent_end(status=completed)
```

Retries and deferred polling likewise complete before the single terminal `agent_end`. Failed and aborted operations end with `status=failed` and `status=aborted`, respectively; failures also preserve the native structured error.

## Reins consumers

- `AgentHarnessPiRuntime` owns native lifecycle listeners and invokes its caller-scoped `SessionInstance`; that sink persists activity and final metadata before scheduling any parent report.
- The frontend promotes final run-local messages and displays authoritative terminal errors from `agent_end`.
- Canonical transcript persistence is independent of these events because AgentHarness commits entries directly through `PiStorageAdapter`.
- Live session waits read the latest durable AgentHarness operation result through the lane API rather than retaining a second adapter-local outcome.
