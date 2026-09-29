# ADR-011: `placement_status` Is the Single Source of Truth for Session Placement

- **Status:** Superseded by [ADR-015](015-server-canonical-storage-stateless-node.md)
- **Date:** 2026-09-27
- **Author:** Will (with Claude)

## Context

While execution moved to nodes, where a session lived was spread across several places: a `sessions.storage_owner` column (`server` or a node), the latest provision/hydrate rows kept in the command outbox (admitted, failed, unknown), and the session's source. Readers (waits, fencing, session views, activity) each combined them differently, and settled outbox rows had to be retained forever to answer placement questions.

## Decision

**`sessions.placement_status` alone says where a session lives**, with a failure reason in `sessions.status_error`. Values: `server` (at rest on the server), `provisioning`, `provisioned`, `provision_failed`, `moving`.

- It is written in the same server transaction as the outbox change that causes it (creating a session with its provision, queueing a move, settling a provision or hydrate).
- Nothing derives placement from outbox rows; settled commands are deleted, making the outbox a queue.
- A failed move is not a status: the hydrate command stores the resting state it left (`revertTo`, server-side only), and failure returns the session there with the reason in `status_error`.
- `storage_owner` was dropped.

## Consequences

- One column answers waits, fencing, activity and the UI's placement display.
- Every placement transition must be written transactionally with its outbox change; startup recovery requeues interrupted provisions and moves (like every interrupted command, 2026-09-28), so their sessions keep `provisioning`/`moving` until the replay settles them.
- Details: [node-contract.md](../dev/node-contract.md) *Session placement*.
