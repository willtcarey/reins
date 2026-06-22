# Pi Runtime Event Ordering

## Purpose

This note records observed Pi runtime lifecycle ordering that matters for Reins session activity and chat status UI.

Reins' Pi adapter is intentionally thin: it subscribes to the Pi `AgentSession` and forwards events unchanged. Do not assume Reins reorders or synthesizes Pi lifecycle events in `packages/backend/src/runtimes/pi/runtime.ts`.

## Key finding

`agent_start` is **not guaranteed** to precede `compaction_start`.

Pi may compact before entering the agent loop for a new prompt. In that case Reins receives compaction events before the run's first `agent_start`.

## Observed event traces

### Normal prompt, no pre-prompt compaction

```text
agent_start → turn_start → message_start → ... → agent_end
```

### Start-of-turn pre-prompt compaction

```text
compaction_start → compaction_end → agent_start → turn_start → ...
```

This happens when Pi checks context size before beginning the new agent loop and decides to compact first. This is the important edge case for activity indicators: a session can be actively doing work even though no `agent_start` has been emitted for the new turn yet.

### Compaction after `agent_end`

Pi can compact after an agent run has already emitted `agent_end`.

Overflow recovery retries the run:

```text
agent_start → ... → agent_end → compaction_start → compaction_end(willRetry=true) → agent_start
```

Threshold compaction does not retry; the user continues manually on the next prompt:

```text
agent_start → ... → agent_end → compaction_start → compaction_end(willRetry=false)
```

This means `compaction_start` does not always lead to a later `agent_end`.

### Manual compaction

If manual Pi compaction is invoked, it can emit:

```text
compaction_start → compaction_end
```

without an adjacent `agent_start`.

## Reins implications

### Broadcast path

`packages/backend/src/runtimes/runtime-broadcast-observer.ts` broadcasts every runtime event as-is. Therefore frontend stores can observe `compaction_start` before any matching `agent_start`.

### Persistence/activity path

`packages/backend/src/runtimes/runtime-persistence-observer.ts` treats:

- `agent_start` as notification/activity `running`
- `compaction_start` as notification/activity `running`
- `agent_end` as notification/activity `finished`
- `compaction_end(willRetry=false)` as notification/activity `finished`

Compaction completion persists messages because non-aborted `compaction_end` is a checkpoint event. `compaction_start` is not a message checkpoint; it only marks the session active.

### UI consequence

It is valid for the chat conversation state to receive `compaction_start` before it receives any `agent_start` for the turn.

Server-managed active-session state must treat `compaction_start` as an independent active state, not as a child event that always occurs inside an already-started agent run.

## Design guidance

When implementing or changing session activity reconciliation:

1. Do not require `agent_start` before `compaction_start`.
2. Treat `compaction_start` as active work for the session.
3. Prefer a specific runtime phase such as `compacting` over overloading unread notification state.
4. On terminal `compaction_end` (`willRetry: false`), do not wait for a later `agent_end`; mark the session finished.
5. Reconnect/refresh reconciliation should be able to recover from missed compaction events and stale compacting state.
