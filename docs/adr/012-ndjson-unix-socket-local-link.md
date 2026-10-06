# ADR-012: NDJSON over a Unix Socket for the Local Node Link

- **Status:** Accepted
- **Date:** 2026-09-27
- **Author:** Will (with Claude)

## Context

The server and the local node run as separate processes and speak JSON-RPC 2.0 (hello/ready negotiation, epochs, capabilities). The protocol only needs a `WireSocket` that sends and receives text frames. The original plan was JSON-RPC over WebSocket for both local and remote nodes.

Findings:

- Bun 1.3.9 can serve WebSocket on a Unix socket, but its WebSocket client cannot dial one: `ws+unix://` is rejected and `unix`/`socketPath` options are ignored.
- WebSocket over loopback TCP works, but any local process could connect, so the link would need its own authentication before serving credentials.

## Decision

**The local link is JSON-RPC 2.0 over a Unix domain stream socket with newline-delimited JSON frames.**

- The endpoint defaults to `~/.reins/run/node.sock` in a 0700 directory, socket 0600. **File permissions are the local authentication**: only the same OS user can connect.
- Framing: one `JSON.stringify` string plus `\n` per frame, reassembled from bytes, with a frame cap (64 MiB locally) and bounded buffering.
- Everything above framing (schemas, negotiation, epochs, heartbeat, replay) is transport-neutral.
- Remote nodes will use WebSocket + TLS with enrollment and authentication, reusing everything above the `WireSocket`.

## Consequences

- No HTTP upgrade or local authentication scheme to build; the server's browser HTTP/WebSocket server stays separate from the node listener.
- Two transports will exist once remote nodes ship; they must stay behind the same `WireSocket` seam.
- Revisit if Bun's WebSocket client gains Unix socket support and one transport is preferable.
- Details: [node-transport.md](../dev/node-transport.md) *1. The socket*.
