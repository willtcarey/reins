# ADR-026: Sources Are Managed on the Server Only

- **Status:** Accepted
- **Date:** 2026-10-10
- **Author:** Will (with Claude)
- **Reverses:** the node-declared sources of commit 953cdae (recorded in [completed/remote-nodes.md](../plans/completed/remote-nodes.md) *Decisions*, "Sources belong to the node", and *What was built*, "Node-owned sources"; that record is left as it was)

## Context

A source is one checkout of a project: a path on a node. The first remote-node build made the node the authority on its own paths. A node declared the checkouts it would serve (`reins node source add|remove|list`, `node.json`'s `sources`, the install command's `--source`), announced them in every `node.hello`, and refused any call naming another checkout, comparing real paths. The server recorded what each node reported (`nodes.reported_sources`) so Settings → Nodes could offer an unattached declared path to a project and flag a project's checkout the node no longer declared. A running node watched its config and redialed to report a change.

That made two records of one fact, the server's `sources` table and each node's list, and every change had to reach both. A project created on a remote node with a typed path failed ("Not a source of this node") until someone declared the path on that machine. Letting the server change the node's list as well would have meant a new wire method, a store injected into the node, and no-redial rules to keep the record in step.

The trust model ([node-architecture.md](../plans/node-architecture.md) *Trust model*) already lets the server run anything on a node: a prompt runs bash in the checkout. A node-side allowlist of directories does not limit what the server can do there. It protects nothing.

## Decision

**The server's `sources` table is the only record of a node's checkouts.** They are managed on the server only: the project form (a project's first checkout on the node chosen; **Add checkout** on another node in a project's settings), `POST /api/projects/:id/sources {nodeId, path}` and the CLI (`reins source add <path> --project <id> [--node <nodeId>]`, `reins source list`).

**The node keeps no list and runs in the path the server sends,** as the local node always has. It still refuses what its operations refuse anyway: a missing checkout, and a path escaping the checkout.

**The server checks a checkout when it records it.** `createSource` and `moveSource` refuse a relative path, list `.` in the directory on its node (`fs.list`; a path that is not a directory there is refused, and an offline node is a 503), and keep a checkout to one project (unique `(node, path)`) and a project to one checkout per node (a session moved to a node works in its project's checkout there).

**Removed:** `reins node source`, the config's `sources` and the "re-pairing keeps the sources" rule, `reins node setup`'s and the install script's `--source`, the hello's `sources` field, the node's enforcement (`assertDeclaredSource`), the config watch and `NodeLinkClient.redial`, `nodes.reported_sources` (migration `051`, which had run on no released database), the "not declared on the node" flag, and Settings' attach-a-reported-checkout flow. Nothing of it had been released, so the bootstrap surface of [ADR-025](025-node-version-handshake.md) changes here without a compatibility path.

## Consequences

- One record: a project created on a remote node with a typed path works. There is nothing to declare on the machine first, and no report to wait for.
- Less machinery: no config field, hello field, re-report path or enforcement on the node. A node's checkouts are known while it is offline because they are the server's own rows.
- Settings → Nodes lists each node's checkouts (path and project) read-only, from the sources table.
- Lost: the node suggesting its checkouts. Choosing a path on a remote machine now means knowing it. A remote directory picker (listing a node's directories through `fs.list` from a root) could replace this later.
- A node cannot refuse a directory the server names. That is consistent with the trust model, and a deployment that wants such a limit needs a node-side permission model (node-architecture.md *Open questions*, privacy and trust), not a list of paths.
- Details: [node-contract.md](../dev/node-contract.md) *Checkout operations* and *Node hub* (default source, nodes and sources); user-facing: [projects.md](../features/projects.md), [nodes.md](../features/nodes.md), [settings.md](../features/settings.md) *Nodes*.
