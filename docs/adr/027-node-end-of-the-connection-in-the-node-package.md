# ADR-027: The Node End of the Connection Lives in the Node Package, as One Module

- **Status:** Accepted
- **Date:** 2026-10-11
- **Author:** Will (with Claude)
- **Amends:** [ADR-014](014-shared-protocol-and-storage-packages.md), which put "the node end of a connection" in `@reins/node-protocol`

## Context

The node end of the node's connection to its server was one concept split three ways, for packaging rather than design:

1. `createNodeConnection` (`@reins/node-protocol`): one socket's node-side protocol over a table of command handlers: the challenge answer, the hello, serving the server→node methods, the server calls, storage slicing and the stream sender.
2. `connectNode` (`@reins/node/node-connection`): a pass-through that wired a `Node` onto level 1 (its handler table, the `NodeRejection` mapping, the capability list, attach and detach).
3. `redialNode` (`@reins/node/redial`): kept the node connected across sockets over a `Dial` (backoff, refusal, update).

Level 1 sat in the shared package because ADR-014 put everything about the link there, but its only production caller was the node. The server never ran it. Backend tests did, to script fake nodes: a handler table passed to `createNodeConnection`, with a test helper that redialed on its own. So the node end those tests ran was not the node's (no error mapping, its own capabilities, its own redial), and three interfaces (handler table, per-socket options, hello object) described one thing.

## Decision

**The node end of the connection is one module in the node package: `packages/node/src/node-connection.ts` (`@reins/node/node-connection`), with one public entry.**

`connectNode(node, transport, { nodeId, key?, buildId?, onState?, onUpdate? }) → { stop() }` keeps a `Node` linked to its server over a `Transport` until stopped: on each socket it answers the challenge with `key`, says hello, serves the node's commands (mapping `NodeRejection`s), serves the streams they open and attaches the socket's server calls to the node; across sockets it redials, stops on a refusal and hands an update to `onUpdate`. The per-socket protocol and the `Node` wiring are private to it (the stream sender is a private helper beside it, `node-connection/streams.ts`), and `redial.ts` is gone.

- **`Transport`** (was `Dial`) is the seam: `{ address, link, open(opened) }`. Its adapters are `unixTransport` (`local-link.ts`), `webSocketTransport` (`remote-link.ts`) and the in-memory transports of tests. The two production adapters stay in their own files: each holds transport-specific code (a Bun socket, a client WebSocket with its dial timeout and drain polling) and its own tests, and `local-link.ts` also holds `DEFAULT_LOCAL_NODE_ID`, which the CLI imports without the connection.
- **`key`** (was `identity`, `NodeIdentity`) is the paired node's signing key and the server origin it signs for (`NodeKey` in `node-auth.ts`, which the protocol keeps because signing and verifying share the signed message); `NodeInstall.key()` reads it. The hello is a protocol message, not a parameter: there is no hello object.
- **Commands.** `NodeCommands` (was the protocol's `NodeCommandHandlers`) and the stream source types (`StreamSource`, `OpenStreamSource`) are part of the `Node` interface in `node.ts`.
- **What stays shared** in `@reins/node-protocol`: the method tables and schemas, the JSON-RPC peer, socket framing and the WebSocket link adapter, `node-auth`, and `negotiation.ts` (`protocolVersion`, `methods`, the hello params and reply schemas both ends read). Reading a hello reply (`helloReply`, `UpdateRequired`) moved with the node end, its only reader.
- **Tests run the real node end.** A scripted fake node is a stand-in `Node` (`scriptedNode`, `@reins/node/testing`: the commands a test scripts, a node failure for any other, the attached server calls exposed) passed to the same `connectNode` over an in-memory transport through the hub's `accept` (`__tests__/helpers/loopback-node.ts`, which no longer redials on its own). Tests that must say something `connectNode` never says (another protocol version, an unknown capability) use a raw JSON-RPC peer. Server production code still never imports `@reins/node/*` (`reins/server-node-process-boundary` now also names `@reins/node/testing`).

Not a wire change: the protocol version stays.

## Consequences

- One interface for the node end, at its natural seam; the node process, `reins node run` and tests cross the same one.
- A scripted node now behaves as a node does: it advertises every command, so a command it was not scripted for reaches it and fails as a node failure (`internal`) rather than being refused as not negotiated; a scripted refusal throws `NodeRejection`.
- `@reins/node-protocol` no longer holds node-only code; a protocol edit still needs a coordinated restart, and a change to the node end is now a node reload.
- Details: [node-transport.md](../dev/node-transport.md) *The layers*, *4. The connection*, *Details: reconnecting*, *Details: test links*; [node-contract.md](../dev/node-contract.md) *Packages and import boundaries*, *Node API*.
