# ADR-008: The Server Is the Hub for Session Relocation

- **Status:** Superseded by [ADR-015](015-server-canonical-storage-stateless-node.md)
- **Date:** 2026-09-27
- **Author:** Will (with Claude)

## Context

Sessions run on nodes, and a session must be able to change node: sessions stored on the server from before nodes existed must reach a node before they can run, a user can move a session to another node, and a node that lost its data must get its sessions back. The server already holds an exact, ordered replica of every node session (see [ADR-009](009-node-canonical-storage-server-replica.md)).

An earlier design moved sessions with a `session.release` command: the old owner handed its copy back to the server before the new owner hydrated it. That needs the old owner to be online and cooperative, adds a second state machine per move, and a node-to-node transfer would additionally need nodes to reach each other.

## Decision

**Every move is a hydrate of the server's copy onto the target node.** Server → node and node A → node B use the same path; there is no release and no node-to-node transfer, and the previous owner is told nothing.

- Queueing a move is one server transaction: check preconditions, re-point the session's `source_id` at the target, queue `session.hydrate` in the command outbox and mark the session `moving`. From that commit the previous owner is fenced: its writes are refused with `not_owner`, on which it drops its copy.
- A node-owned session moves only when it is idle as seen by the server (no active run, pending input or undelivered command). Run settlements are delivered after the run's commits, so the replica is then complete through the last run.
- The target pulls the server's rows in pages (`session.snapshot`) plus referenced attachments, writes them verbatim in one transaction and verifies row counts and a digest. A node holding a different copy replaces it wholesale; an identical copy acknowledges at once.
- The same mechanism serves lazy migration of sessions at rest on the server and re-hydration after lost node data.

## Consequences

- Moves work while the previous owner is offline and need no node-to-node connectivity.
- **Accepted loss:** commits the old owner made outside a run (e.g. a model change's lane write) and had not delivered before the move are lost.
- Sessions with active runs cannot move; moving them is open work.
- The whole copy is pulled on every move (no prefix/tail optimization), and the node holds a hydrating session in memory until its single write transaction.
- Details: [node-contract.md](../dev/node-contract.md) *Session relocation*.
