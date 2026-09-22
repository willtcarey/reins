# Session Context Usage

Status: **completed**

The intended user need was a compact indication of how full the selected session's model context is. This was implemented in the chat footer. Broader cumulative usage, cost reporting, dashboards, and cross-runtime accounting are not part of the completed scope.

## Delivered behavior

- The footer displays current context occupancy beside the session model picker.
- It shows token and percentage detail, remains accessible when responsive text is hidden, and warns near the AgentHarness compaction threshold.
- Exact values come from the latest valid assistant usage embedded in the canonical active branch, using AgentHarness context-token semantics.
- Cumulative session statistics and standalone structural requests such as compaction summarization are not treated as context occupancy.
- Trailing context, branch summaries, and post-compaction replacement context are estimated and labeled with `~`.
- Occupancy is shown as unknown while compaction is active.
- The selected model supplies the context-window denominator, including after model changes.
- One canonical REST context resource restores state on initial load, refresh, and reconnect. Existing durable-entry and compaction events invalidate or refresh that resource; there is no separate usage WebSocket protocol.

## Architecture

- `models/session-context.ts` projects the canonical active AgentHarness branch and returns a normalized `SessionContextSnapshot`.
- `GET /api/sessions/:sessionId/context` exposes the snapshot through the internal `ReinsClient`.
- `ActiveSessionStore` owns the selected session's snapshot and stale-request protection.
- `session-context-usage` owns the compact responsive and accessible presentation.
- The Pi runtime exposes process-local compaction visibility so same-process refreshes do not restore a stale exact value during compaction.

## Deliberately excluded

The following ideas from the earlier exploratory plan were not required for the intended feature and are not roadmap commitments:

- aggregate token or cost reporting;
- per-project, per-model, or date-based usage charts;
- a separate token-usage reporting table;
- Claude SDK usage accounting while that runtime remains unregistered.

AgentHarness continues to persist complete Pi accounting rows in `pi_usage`. A future aggregate-reporting feature can use those durable records without changing the context-occupancy contract.

## Known limitation

Compaction visibility is process-local because AgentHarness does not publicly expose a durable internal compaction phase. Browser refresh and reconnect against the same backend correctly show unknown occupancy during compaction. A backend restart during an already-running compaction cannot reconstruct that phase perfectly without a future public AgentHarness API or reliance on private state.
