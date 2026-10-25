# ADR-031: Session Operations over HTTP, the Browser Socket for Broadcasts Only

- **Status:** Accepted
- **Date:** 2026-10-24
- **Author:** Will (with Claude)

## Context

The browser sent prompt, steer and abort over its WebSocket, with its own protocol: an `ack` or an `error` frame matched to the message by `clientId`, and a client buffer that sent unacknowledged messages again when the socket reconnected. The protocol dates from the outbox, when the server delivered commands to nodes and needed acknowledgements of its own. ADR-029 removed the outbox: a submission is acknowledged once Pi committed it, and a repeat under the same `clientId` converges on it. A request and its response give exactly that.

Every other session operation (model change, compaction, resume) was already HTTP. So:

- The two channels had no order between them: a prompt over the socket and a model change over HTTP could reach the server in either order.
- A failed prompt reached its caller only as an event on the socket's bus, which `ConversationsStore` matched to the pending message. The SDK's `sessions.create({prompt})` resolved before the prompt was admitted and never saw its failure.
- A prompt sent during a dev reload's gap was answered with an `error` frame without a `clientId`, so the client kept it buffered. The socket stays open across a reload, so no reconnect came to send it again: the prompt stayed pending.
- Tests and scripts needed a socket and the ack protocol to prompt a session.

## Decision

**Session operations are HTTP routes; the browser socket carries the server's broadcasts and the heartbeat only.**

- `POST /api/sessions/:id/prompt` and `/steer` (`{clientId, message}`) answer once Pi committed the input; `POST /api/sessions/:id/abort` answers `{aborted}`. `ReinsClient.sessions.prompt`, `steer` and `abort` call them. The WS handler answers anything but `ping` with an error.
- **The frontend orders a session's operations itself** (`SessionOperations`): its submissions, model changes and compactions go one at a time, each once the server answered the one before, since concurrent requests can arrive in any order. Abort goes at once. The server still applies each session's operations in arrival order (its submission chain), for its other senders.
- **The frontend retries a submission the server did not answer** (a network failure, or a 503 during a reload's gap) under the same `clientId`, with backoff, until it is answered. This replaces the socket's replay buffer.
- **Where a session's logic lives does not change:** routes, scripting and a future server-side part of the SDK are adapters over `Sessions`.

## Consequences

- A failure is the request's answer, so the composer and the SDK handle it where they submitted. `create({prompt})` resolves once the prompt was admitted and rejects with its refusal.
- An operation that waits for an earlier one waits a round trip, not only the server's admission. This matters only for operations sent within that time of each other.
- A submission held by a network failure holds the session's later operations, as the socket's ordering did.
- The `ack` frame, the client's replay buffer and the WS `error` event handling in the stores are gone.
