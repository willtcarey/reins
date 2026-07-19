# ADR-007: Durable Streams Protocol for Runtime Event Replay

- **Status:** Rejected
- **Date:** 2026-07-14
- **Author:** Will (with Reins)

## Context

Reins broadcasts runtime events over WebSocket while persisting canonical conversation messages to SQLite at runtime checkpoints. We evaluated adopting the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol and `@durable-streams/client` to make runtime deltas persistent and replayable.

The proposed design created one SQLite-backed stream per session, wrote every runtime event to it, exposed offset-based catch-up and SSE tail endpoints, and truncated events once the corresponding message snapshot had been persisted. WebSockets would remain for prompt/steer/abort commands and app-level notifications.

The direction aimed to address:

- reconnects during an in-progress turn
- multi-tab clients missing ephemeral runtime deltas
- post-hoc turn/tool timing analysis
- telemetry currently discarded from runtime SDK results

## Decision

**Reject adopting the Durable Streams protocol and client library for Reins runtime event delivery.**

Reins will keep WebSocket runtime delivery and SQLite `session_messages` as the canonical transcript. We will solve concrete loading, reconnect, and telemetry problems independently rather than introduce a second stream protocol and persistence model.

If exact mid-turn replay becomes important enough, prefer a small Reins-owned bounded replay buffer with monotonically sequenced runtime events. Do not adopt the Durable Streams protocol unless future requirements exceed that simpler model.

## Reasons

### 1. The proposed stream was only an in-progress replay buffer

The design truncated stream events at each persistence checkpoint. It therefore was not a durable long-term event log; it retained only events newer than the latest canonical message snapshot.

Its primary unique benefit was exact replay of an interrupted in-progress turn. That benefit did not justify a general durable-stream protocol, metadata model, and client dependency.

### 2. It introduced a second transport and synchronization model

The proposal retained WebSockets for outbound commands and app-level events while adding SSE for runtime events. The frontend would need to coordinate:

- a persisted message cursor
- a durable stream offset
- WebSocket connection state
- SSE connection state
- checkpoint/truncation races
- stale offsets after reconnect
- independent state across tabs

This is significantly more complex than the current runtime observer and conversation-store model.

### 3. Existing reconciliation covers completed turns

Canonical messages and persisted session activity allow the frontend to reconcile after a missed `agent_end` or completed turn. Remaining reconnect fragility is mostly limited to the live, uncheckpointed portion of a turn.

A bounded event replay table or periodic checkpointing could address that narrower problem without changing the transport architecture.

### 4. Telemetry does not depend on durable streams

Claude SDK result messages already expose aggregate timing, turn count, usage, and cost fields. Tool and turn durations can be derived by timestamping observer events and persisting telemetry rows directly.

Telemetry should be pursued separately if useful; it does not require replaying runtime deltas through Durable Streams.

### 5. It did not solve transcript loading or compaction history

Persisting runtime events would not reduce the cost of loading and rendering large conversations. Cursor-paginated message history addresses that problem directly.

The proposal also cited compaction history loss, but truncating stream events after checkpoints would not preserve pruned historical tool output. Solving archival retention would require a separate explicit policy.

### 6. A smaller fallback remains available

If future evidence shows users need exact mid-turn recovery, Reins can add:

- a per-session monotonic runtime event sequence
- a bounded SQLite or in-memory replay buffer
- client acknowledgement of the last applied sequence
- replay from that sequence after reconnect
- cleanup once canonical message persistence passes the buffered events

That design can remain internal to the existing WebSocket/event contract and be introduced only when justified by observed failures.

## Consequences

- Do not add `@durable-streams/client` or Durable Streams protocol endpoints.
- Do not replace runtime WebSocket delivery with SSE.
- Keep `session_messages` as the canonical persisted conversation.
- Continue improving reconnect reconciliation through canonical session/message state.
- Treat message pagination and frontend streaming-render performance as separate priorities.
- Capture SDK timing/cost telemetry directly if a concrete product or debugging need emerges.
- Reconsider a bounded sequenced replay buffer only if mid-turn event loss remains a demonstrated problem.

## Related documents

- [Durable event streams research proposal](../plans/completed/durable-event-streams.md)
- [ADR-002: SQLite sessions](002-sqlite-sessions.md)
