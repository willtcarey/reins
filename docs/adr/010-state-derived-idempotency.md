# ADR-010: State-Derived Idempotency Instead of Receipt Tables

- **Status:** Accepted; narrowed by [ADR-015](015-server-canonical-storage-stateless-node.md) (replica and report watermarks are gone; command idempotency stays)
- **Date:** 2026-09-27
- **Author:** Will (with Claude)

## Context

The server delivers session commands to nodes through a durable outbox, and nodes deliver commits and lifecycle reports back. Any delivery can lose its acknowledgement (timeout, dropped link, restart of either side), so both directions must tolerate replays. The first implementation kept per-command receipt tables on the node (`admission_receipts`) and per-report receipt tables on the server, keyed by outbox command ID. Receipts grew without bound, had to be kept consistent with the state they described, and still needed a state check for replays that arrived under a new ID.

## Decision

**"Already applied" is derived from the state each operation produces; there are no receipt tables on either side.** A replay is acknowledged as success and applies nothing twice.

- **Commits:** the server's per-session `harness_next_seq` watermark plus the hash of the last applied batch. Lower start sequences are replays; a gap or a different last batch is rejected as divergence.
- **Lifecycle reports:** the last applied report's `(runId, kind)` and payload hash, one row per session, updated in the same transaction as the report's effects.
- **Commands:** provision converges on its binding and existing lane; prompt/steer on Pi's durable input keyed by `reinsId` (the client's ID); setModel is an absolute selection; hydrate converges by content. No outbox command ID crosses the wire.
- **Attachment uploads:** the same content under the same node-assigned ID.
- Unknown outcomes of submitted work are requeued and replayed; immediate controls (abort, resume) are never replayed.

## Consequences

- Nothing grows per command or report; retries need no reconciliation step.
- Residual cases are documented rather than detected: a steer whose reply was lost and that an abort discarded before the replay is re-queued; commit batches older than the last applied one are acknowledged without comparison.
- The command outbox became a plain queue: settled commands are deleted, and no session state is read from it ([ADR-011](011-placement-status-single-source-of-truth.md)).
- Details: [node-contract.md](../dev/node-contract.md) *Replay idempotency*.
