# ADR-024: The Node Link's Origin Comes From the Upgrade Request

- **Status:** Accepted
- **Date:** 2026-10-10
- **Author:** Will (with Claude)
- **Builds on:** [ADR-023](023-node-pairing-and-challenge-authentication.md) (the challenge signs the server origin the node dialed; the transport supplies the origin it checks)

## Context

A remote node answers the server's challenge with a signature over `["reins-node-auth-v1", origin, nodeId, challengeId, nonce]`, where `origin` is the origin of the server URL it was paired with (`new URL(config.serverUrl).origin`, always http or https, though it dials `ws://` or `wss://`). The server checks the signature against the origin its transport gives the connection (`state.nodes.accept(socket, {authenticate: {origin}})`). ADR-023 left open which origin the WebSocket route passes when the server sits behind a proxy (e.g. `tailscale serve` terminating TLS and forwarding to `http://localhost:3100`): there the request URL the server sees is not the URL the node dialed.

Options: a configured public URL (one more setting, wrong whenever the server is reached under more than one name, and needed before the first node can connect), or the request itself, with the proxy's forwarded headers.

## Decision

**The `/node/link` route derives the origin from the upgrade request, with no configuration** (`requestOrigin` in `nodes/node-link.ts`):

- the scheme from `X-Forwarded-Proto` (its first value), else the request URL's;
- the host from `X-Forwarded-Host` (its first value), else the `Host` header;
- as an http(s) origin: `https` for `https` or `wss`, otherwise `http`, normalized by `URL` (default ports dropped, host lowercased). A host that is not just a host (a path, user or query in it) refuses the upgrade (400).

The first value counts because each proxy in a chain appends its own.

## Consequences

- A node paired under the name the user reaches the server by (the settings page's URL) authenticates behind a proxy that sets the forwarded headers, and directly, without configuration.
- **The limit:** the headers are whatever the client sends. Anyone who can reach the server can claim any origin, so the binding does not authenticate the network path. Under the private-network trust model ([node-architecture.md](../plans/node-architecture.md) *Trust model*) that is no concern: anyone who can reach the server is already an administrator (the browser API is unauthenticated). What the binding still does is stop a signature made for one server origin from being accepted by a server reached under another: a challenge answer recorded from, or produced for, `https://a.example` is refused by a server whose request says `https://b.example`, and every answer is bound to its one-use challenge anyway.
- A proxy that rewrites `Host` without setting `X-Forwarded-Host` makes the server see the proxy's target, and pairing under the public name then fails to authenticate ("Not authenticated"). Configure the proxy to forward the host, or pair with the URL the server sees.
- If Reins is ever exposed beyond a private network, frontend authentication comes first (*Open questions*), and then the forwarded headers should be trusted only from configured proxies.
- Details: [node-transport.md](../dev/node-transport.md) *The WebSocket link*.
