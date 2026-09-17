# AgentHarness Pi Runtime Event Ordering

## Current adapter

The registered Pi runtime uses AgentHarness 0.85.1. Reins maps AgentHarness events to its normalized runtime contract; it no longer exposes the earlier `AgentSession` lifecycle as the current adapter contract.

## Terminal boundary

AgentHarness emits `run_end` from the durable terminal commit after all operation-owned work has resolved, including:

- provider retries
- deferred response polling
- accepted steering
- automatic compaction

The adapter maps that event directly to normalized `agent_end`. `agent_end` is consequently both the session activity completion boundary and the child parent-report boundary.

There is no normalized `agent_settled` event and no `AgentRuntime.activityCompletionBoundary` capability. The removed synthetic event merely waited for Reins to delete the operation from its local `activeOperations` map after `lane.drive()` returned; that bookkeeping does not represent additional AgentHarness work or persistence.

A listener invoked for native `run_end` can still observe `runtime.isStreaming() === true` during the callback because local operation cleanup follows event delivery. Consumers must use `agent_end` as the terminal event rather than deriving the lifecycle boundary from that callback-time local flag. APIs such as `waitForIdle()` continue to wait through local cleanup before resolving.

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

- `runtime-lifecycle-observer.ts` synchronously marks activity running on `agent_start` or `compaction_start`, then persists final runtime metadata and marks activity finished on `agent_end`.
- `runtime-parent-report-observer.ts` is subscribed afterward and reports on `agent_end`.
- The frontend promotes final run-local messages and displays authoritative terminal errors from `agent_end`.
- Canonical transcript persistence is independent of these events because AgentHarness commits entries directly through `PiStorageAdapter`.
- Live session waits read the latest durable AgentHarness operation result through the lane API rather than retaining a second adapter-local outcome.
