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

Threshold compaction does not retry:

```text
agent_start → ... → agent_end → compaction_start → compaction_end(willRetry=false) → agent_settled
```

A real Pi 0.80.6 threshold trace now confirms the second ordering. The complete
lifecycle boundaries in that one-tool-free run were:

```text
agent_start
→ turn_start
→ user message_start
→ user message_end
→ assistant message_start
→ assistant message_update*
→ assistant message_end
→ turn_end
→ agent_end(willRetry=false)
→ compaction_start(reason=threshold)
→ compaction_end(reason=threshold, aborted=false, willRetry=false)
→ agent_settled
```

Immediately before and immediately after calling `session.prompt()`, the capture
observed `session.isStreaming=false`; Pi's async preflight had not yet entered
`_runAgentPrompt()`. At the subsequent `agent_start`, `agent_end`,
`compaction_start`, and `compaction_end` subscriber callbacks,
`session.isStreaming` was `true`. It changed to `false` before the
`agent_settled` callback, and remained false after `session.prompt()` settled.
Thus Pi's session-level streaming state remains active across this post-agent
threshold compaction even though the inner agent loop has emitted `agent_end`.
Activity representing the whole Pi prompt should remain running until settlement;
it should not infer idleness from this pre-compaction `agent_end` alone.

This is not proactive compaction in the middle of an assistant/tool turn. Pi
0.80.6 source says proactive mid-turn compaction was removed: automatic
compaction is checked after an agent run, or before a later prompt using the last
assistant message. Overflow is also handled after the failed agent run and may
retry. This means `compaction_start` does not always lead to a later `agent_end`.

### Manual compaction

Pi 0.80.6 exposes manual compaction as
`AgentSession.compact(customInstructions?: string): Promise<CompactionResult>`.
It aborts any active agent operation, prepares context using the configured
`compaction` settings, optionally adds the supplied instructions to the summary,
appends a compaction session entry, and refreshes `session.messages` from the
compaction-aware session context. A real direct invocation emitted exactly:

```text
compaction_start(reason=manual)
→ compaction_end(reason=manual, aborted=false, willRetry=false)
```

There was no adjacent `agent_start`, `agent_end`, or `agent_settled`. Manual
compaction is therefore a standalone native Pi lifecycle, unlike threshold
compaction inside `prompt()`, and ends at `compaction_end`. Reins currently has
no production manual-compaction trigger, so its settlement-aware activity policy
is intentionally scoped to reachable automatic prompt activity; adding a manual
trigger would require defining that separate activity path rather than waiting
for an `agent_settled` that Pi does not emit.

## Reins implications

### Broadcast path

`packages/backend/src/runtimes/runtime-broadcast-observer.ts` broadcasts every runtime event as-is. Therefore frontend stores can observe `compaction_start` before any matching `agent_start`.

### Persistence/activity path

Pi declares `activityCompletionBoundary = "agent_settled"`, so `packages/backend/src/runtimes/runtime-persistence-observer.ts` treats:

- `agent_start` as notification/activity `running`
- `compaction_start` as notification/activity `running`
- `agent_end` as a messages/metadata checkpoint while activity remains `running`
- successful `compaction_end` as a compacted-message checkpoint while automatic activity remains `running`
- `agent_settled` as notification/activity `finished`

Settlement is queued behind prior checkpoint persistence before the finished `session_updated` broadcast. `compaction_start` is not a message checkpoint; it only marks the session active. Pi manual compaction remains compaction-only and emits no settlement, but Reins currently has no production trigger for manual compaction; this task deliberately adds no manual compaction API or special-case lifecycle.

### UI consequence

It is valid for the chat conversation state to receive `compaction_start` before it receives any `agent_start` for the turn.

Server-managed active-session state must treat `compaction_start` as an independent active state, not as a child event that always occurs inside an already-started agent run.

## Compaction event trace fixture

A raw, real Pi `AgentSession.subscribe()` threshold-compaction capture lives at
`packages/backend/src/__tests__/runtimes/pi/fixtures/compaction-trace.json`.
Each ordered event stores the event snapshot, elapsed time, and the callback-time
values of `session.isStreaming` and `session.isCompacting`. It also records state
immediately before and after invoking `prompt()`, and after prompt settlement.
The fixture used `openrouter/openai/gpt-oss-20b`, no tools, and this in-memory Pi
configuration:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 131072,
    "keepRecentTokens": 1
  }
}
```

That model's context window was 131072. Pi 0.80.6 checks
`contextTokens > contextWindow - reserveTokens`, so any successful response with
nonzero usage crossed the threshold. Keeping one recent token gave Pi an
eligible split-turn prefix to summarize. This forced a cheap threshold
compaction after the first `agent_end`; it did not fabricate an overflow.

One subtle observed detail is that `session.isCompacting` was still false in the
`compaction_start` callback and true in the `compaction_end` callback. Pi emits
`compaction_start` immediately before installing its auto-compaction abort
controller, and clears that controller after emitting `compaction_end`. Consumers
should use lifecycle events, not callback-time `isCompacting`, to identify these
boundaries.

Recapture from the repository root with a working configured credential:

```sh
bun run --cwd packages/backend capture:pi-compaction-trace \
  --output src/__tests__/runtimes/pi/fixtures/compaction-trace.json \
  --provider openrouter --model openai/gpt-oss-20b
```

The provider/model are selectable. Use a model whose credential and endpoint are
currently available, then review that `error` is null and both compaction events
exist before retaining the fixture. The capture contains no tools, credentials,
or machine-specific paths.

### What is and is not observed

- **Observed live:** threshold compaction after `agent_end`, with
  `isStreaming=true` through both compaction callbacks and false at
  `agent_settled`.
- **Source-supported, not captured by this fixture:** overflow compaction retries
  with `willRetry=true`; a successful over-window answer may instead produce an
  overflow-reason compaction with `willRetry=false`.
- **Source-supported, not captured by this fixture:** the pre-prompt check runs
  before `_runAgentPrompt()` sets Pi's session run-active flag, so a standalone
  pre-prompt compaction can have `isStreaming=false` until the new agent run
  starts.
- **Not a Pi 0.80.6 automatic mode:** proactive threshold compaction in the
  middle of an assistant/tool turn. The live trace's compaction occurs during
  the outer prompt lifecycle but after the inner agent run ended.

## Manual compaction event trace fixture

The sanitized real Pi `AgentSession.subscribe()` capture at
`packages/backend/src/__tests__/runtimes/pi/fixtures/manual-compaction-trace.json`
was produced with Pi 0.80.6. The capture first called `session.prompt()` to build
a real user/assistant turn, waited through that run's `agent_settled`, then called:

```ts
await session.compact("Preserve the seed completion exactly.");
```

Automatic compaction was disabled while capturing (`enabled: false`) so the
observed compaction could only come from the direct manual entrypoint.
`keepRecentTokens: 1` made the existing turn eligible for a split-turn summary;
`reserveTokens: 16384` supplied the summarization output budget. These are normal
`SettingsManager` compaction settings, not an automatic threshold trigger.

At both manual event callbacks, `session.isStreaming` was false and
`session.isCompacting` was true. `isCompacting` was false immediately after the
`compact()` call because the method first awaits aborting any prior operation;
it was also false when the returned promise's fulfillment callback ran and after
the caller's await resumed. The boundary was:

```text
before compact():                 streaming=false, compacting=false
immediately after compact():      streaming=false, compacting=false
compaction_start callback:        streaming=false, compacting=true
compaction_end callback:          streaming=false, compacting=true
compact promise fulfillment:      streaming=false, compacting=false
after await:                      streaming=false, compacting=false
```

The session manager changed from four entries (model change, thinking-level
change, user message, assistant message) to those same entries plus one
`compaction` entry. The active `session.messages` changed from `[user,
assistant]` to `[compactionSummary, assistant]`, confirming both the append-only
persistence effect and the refreshed context presented after compaction.

Recapture from the repository root with a working configured credential:

```sh
bun run --cwd packages/backend capture:pi-manual-compaction-trace \
  --output src/__tests__/runtimes/pi/fixtures/manual-compaction-trace.json \
  --provider openrouter --model openai/gpt-oss-20b
```

The provider and model are selectable together. Review `error`, the manual event
slice, and the fixture diff before retaining a recapture; generated summary text,
provider metadata, timing, and update counts may vary. The script sanitizes the
temporary workspace and does not serialize credentials or machine paths.

Do not generalize this trace to automatic modes:

- **Manual:** direct `compact()` promise; no agent lifecycle or `agent_settled`;
  `compaction_end` ends activity.
- **Threshold:** part of the outer `prompt()` lifecycle after `agent_end`; emits
  `agent_settled` after `compaction_end`.
- **Overflow retry:** automatic recovery may emit `willRetry=true` and begin a
  new `agent_start` after compaction.

## Tool-using event trace fixture

A raw, real Pi `AgentSession.subscribe()` capture lives at
`packages/backend/src/__tests__/runtimes/pi/fixtures/tool-trace.json`. It records
an ordered read-then-bash run, final session messages, and a small derived
summary. The fixture is sanitized by replacing the temporary workspace and home
paths; it contains no credentials.

The captured Pi 0.80.6 run shows three assistant turns. For each assistant
message, the numeric `timestamp` is stable from `message_start` through every
`message_update` and `message_end`, and every event carries Pi's complete current
message snapshot rather than only the latest delta. Provider `responseId` is absent at
`message_start`, appears on the first update, and then stays stable through
`message_end`. Tool call block `id` equals the `toolCallId` used by
`tool_execution_start`, updates, the matching end, and the later `toolResult`.
Pi also emits `message_start`/`message_end` lifecycles for user and tool-result
messages, so frontend assistant stream matching must first scope by
`role: "assistant"`. Timestamps are not globally unique message IDs: in this
capture, the bash `toolResult` and following assistant message share the same
millisecond value.
The relevant ordering is:

```text
assistant message_end(with toolCall)
→ tool_execution_start
→ tool_execution_update*
→ tool_execution_end
→ toolResult message_start
→ toolResult message_end
→ turn_end
→ next turn_start
```

Recapture from the repository root with configured Reins Pi credentials:

```sh
bun run --cwd packages/backend capture:pi-runtime-trace \
  --output src/__tests__/runtimes/pi/fixtures/tool-trace.json
```

The script uses the configured utility/default model, falling back to the first
authenticated Pi model. Pass `--provider <provider> --model <model-id>` together
to select one explicitly. It creates a temporary portable workspace and enables
only the `read` and `bash` tools. Review the resulting diff before keeping a
recapture because provider tokenization and update counts may vary.

## Design guidance

When implementing or changing session activity reconciliation:

1. Do not require `agent_start` before `compaction_start`.
2. Treat `compaction_start` as active work for the session.
3. Prefer a specific runtime phase such as `compacting` over overloading unread notification state.
4. Select terminal activity through the runtime capability, not runtime-type checks: default runtimes finish at `agent_end` or terminal `compaction_end`; settlement-aware Pi automatic work finishes at `agent_settled`.
5. Preserve transcript checkpoints at `turn_end`, `agent_end`, and successful `compaction_end`, and queue settlement behind them.
6. Reconnect/refresh reconciliation should be able to recover from missed compaction events and stale compacting state.
