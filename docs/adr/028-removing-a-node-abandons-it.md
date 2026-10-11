# ADR-028: Removing a Node Abandons It

- **Status:** Accepted
- **Date:** 2026-10-11
- **Author:** Will (with Claude)
- **Amends:** [ADR-023](023-node-pairing-and-challenge-authentication.md) (removal deleted the node's row)

(An earlier ADR-028, "nodes run the machine's Bun", was reverted before release; this number is reused.)

## Context

Removing a paired node deleted its `nodes` row, so it was refused while the node held sources: a source is a path on one node (`sources.node_id` references `nodes`), and every session hangs off a source (triggers refuse a session without one). The only way to remove a node that had ever held a project's source was to delete those projects first. Most sessions are never revisited, and their history lives on the server ([ADR-015](015-server-canonical-storage-stateless-node.md)), so a node's sessions do not need resolving when the node goes.

## Decision

**Removing a node marks it removed (`nodes.removed_at`) and keeps its row**, so its sources and their sessions stay as they are. Removal closes its link and refuses it at every later hello (`NODE_REFUSED` "Node removed: <id>"; it keeps its key, as a revoked node does, so it reaches the hello). It works whatever the node holds; only the never-paired local node cannot be removed.

- Removed nodes are not listed (Settings → Nodes, the node choosers, move targets, health) and a project's default source skips sources on them.
- A session on a removed node's source stays readable. Work for it is refused at once ("This session's node was removed; move it to another node to continue"): new work at submission, queued work as it comes up for delivery, and a run the server still saw running is ended as interrupted. The session is moved to a live node when someone comes back to it.
- Re-pairing the machine creates a new node; its old sessions move over as they are opened.

## Consequences

- Removing a node never needs projects or sessions deleted first; cleanup happens in the natural course of revisiting a session.
- Removed nodes' rows, sources and sessions accumulate; nothing prunes them.
- A project whose only sources are on removed nodes has no default source until one is added.
- Details: [node-contract.md](../dev/node-contract.md) *Pairing and authentication* (Removal), *Node hub*, *Moving a session*; [settings.md](../features/settings.md) *Nodes*; [nodes.md](../features/nodes.md).
