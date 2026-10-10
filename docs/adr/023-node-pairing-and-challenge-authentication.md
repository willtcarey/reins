# ADR-023: Node Pairing and Challenge Authentication

- **Status:** Accepted
- **Date:** 2026-10-08
- **Author:** Will (with Claude)
- **Builds on:** [ADR-012](012-ndjson-unix-socket-local-link.md) (the `WireSocket` seam; the local socket's file permissions as its authentication), [ADR-022](022-shared-api-client-package.md) (CLIs call the HTTP API through `@reins/client`)

## Context

The node architecture plan ([node-architecture.md](../plans/node-architecture.md) *Trust model*, *Pairing from the settings page*, *Connection*) settled the shape: single-use 256-bit pairing codes stored as a SHA-256, an Ed25519 key per node, a server-first challenge signed over a domain-separated tuple before `node.hello`, and revocation. Shipping it raised questions the plan left open, and some of the answers become bootstrap surface on remote machines, hard to change later.

## Decision

**The challenge is a JSON-RPC request inside the link, not a separate handshake.** The server calls `node.authenticate {challengeId, nonce}` on the connection's peer as soon as it is created; the node answers `{nodeId, signature}`. The node sends `node.hello` at once, without waiting to be challenged: the server answers it only once the challenge is, so the order is enforced in one place, and a node with an identity negotiates unchanged on a transport that does not challenge. It reuses the peer's framing, timeouts and frame caps over any `WireSocket`, so the WebSocket transport gets it unchanged. A separate raw-frame handshake ahead of the peer was considered: it is one more framing layer to keep in step, for nothing the peer does not already do.

- One challenge per connection, consumed by the first answer whatever its outcome. A failed challenge refuses the hello with `NODE_REFUSED` (`-32005`) "Not authenticated", the same answer whether or not the node ID exists; the connection is not closed at once, so the waiting hello gets that answer and the node stops redialing, and the hello timeout closes a peer that never says hello. The server's hello handler waits for authentication and refuses a hello for any other node ID, also with `NODE_REFUSED`. The node signs as its hello's node ID: its identity is only its key and the origin it dialed.
- Signed bytes: UTF-8 of `JSON.stringify(["reins-node-auth-v1", origin, nodeId, challengeId, nonce])`. A JSON array cannot be made ambiguous by a field containing a delimiter.
- Public keys are base64url of the raw 32 bytes (the JWK `x`), canonical, one node per key. `node-auth.ts` owns the encoding (`generateNodeKeyPair`, `encodeNodePublicKey`, `parseNodePublicKey`); the CLI, the pairing endpoint and verification all go through it.
- The challenge's params and result parse tolerantly (`z.object`): they are bootstrap surface and may only grow.
- No protocol version bump: the challenge precedes negotiation and the local link does not use it.

**The transport decides whether a connection authenticates.** `state.nodes.accept(socket, {…, authenticate: {origin}})` challenges; without `authenticate` the connection is trusted to be whichever known node it announces. The local Unix socket passes none: its file permissions remain its authentication, as ADR-012 decided, so the local node needs no pairing, and a paired node may also connect over it (anything that can open the socket can read the server's database anyway). The server checks the signed origin against the origin its transport gives the connection.

**Revocation is enforced at the hello, on every transport.** The challenge checks only that the node holds the key it was paired with; a revoked node keeps its key, passes the challenge and is refused at `node.hello` ("Node revoked: <id>"), whatever transport carried it, by the one check every hello makes (`NodeModel.assertMayConnect`). Revoking closes its link. Only paired nodes can be revoked; the seeded local node cannot.

**Pairing redemption has one winner and one answer.** The grant is consumed by a conditional `UPDATE` in the transaction that inserts the node, so a failed redemption (a malformed or already-registered key) consumes nothing. Unknown, used and expired codes all answer 403 with one message.

**The node's files commit through the config.** `reins node pair` (`packages/cli/src/node/pair.ts`, the files in `node/config.ts`) writes the key to `keys/<nodeId>.pem` (a new file per pairing) and then the config `node.json` by rename. The config is the commit point: a failure never leaves a config pointing at a missing or mismatched key, and `--force` removes the previous key only after the new config is in place. An existing config refuses the run before the code is sent, so the code is not burned. Exit codes are fixed (0 paired, 1 failure, 2 usage, 3 already paired, 4 code refused, 5 unreachable or not answering as Reins; a Reins error answer is 1).

## Consequences

- The WebSocket route must call `accept` with the origin the node dialed. Behind a proxy that may not be the request's URL; that item decides between a configured public URL and forwarded headers.
- The challenge is the connection's first frame, so a transport must accept outbound frames as soon as it hands the socket to the hub (for WebSocket, from `open`).
- Every refusal is one recognisable code, `NODE_REFUSED` (`-32005`), distinct from the `-32003` of a stale epoch: an unknown or never-paired node gets "Not authenticated" (the reason is logged on the server), a revoked node, which still holds its key, "Node revoked: <id>" (also logged). The dialer stops on it instead of redialing, and a supervised node exits with a code the supervisor does not restart (node-contract.md *Process model*).
- Deferred, as the plan says: key rotation (revoke and re-pair), fingerprint confirmation, an audit log, pruning old grants.
- Details: [node-contract.md](../dev/node-contract.md) *Pairing and authentication*, [node-transport.md](../dev/node-transport.md) *4. The connection*.
