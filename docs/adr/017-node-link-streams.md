# ADR-017: Node→Server Streams With Local Backpressure

- **Status:** Accepted
- **Date:** 2026-10-03

## Context

Server git and file operations are moving behind node requests, and some of their results are unbounded: `/diff/patch` pipes git's stdout straight into the HTTP response. Background processes on the node will later need to stream their output too. A request/reply carries one bounded frame, and the NDJSON socket's outbound queue is uncapped, so a node that wrote a large result at once would also delay every frame behind it: storage commits, lifecycle reports, heartbeats.

## Decision

Add a generic stream primitive to the link (protocol version 5; details in [node-contract.md](../dev/node-contract.md) *Streams*):

- A server→node request opens a stream. **The server allocates the stream ID** and registers it before sending the request, because the node may send chunks before its reply and one socket read can deliver the reply and those chunks together.
- The node sends `stream.data {streamId, offset, data}` notifications, where `offset` is the absolute UTF-8 byte offset of the chunk, then `stream.end {streamId, error?}`. The server sends `stream.cancel {streamId}`. Chunks are text (64 KiB of source bytes at most), not base64.
- **No credit or flow-control protocol. Backpressure is local on each side.** The node sends a chunk only once its socket has written out the one before, so other frames interleave and its queue holds about one chunk. The server buffers each stream in memory until its consumer reads it and fails the stream past a 64 MiB cap rather than spilling to disk.
- The server's stream registry is per connection and process-owned (with the hub, [ADR-016](016-process-owned-node-hub.md)). A bad chunk (an offset gap, an unknown stream) fails or drops that stream only. A dropped link fails every stream open on it, and nothing resumes on the next connection.

Rejected: a credit-based window (the server granting the node bytes to send). The server's consumer is usually an HTTP response that Bun drains as fast as the client reads. A window would add a round trip per grant and protocol state on both sides, to bound memory that the per-stream cap already bounds. If a consumer turns out to be slow and long-lived (a background process watched for hours), the cap fails the stream visibly, and spilling to disk or adding a window can be decided then.

## Consequences

- An HTTP route returns a node stream as a `Response` body (`state.nodes.openStream` → `{result, body}`); cancelling the body stops the producer on the node.
- A server with consumers that read slowly can hold up to the cap in memory per open stream.
- Absolute offsets let a later process stream resume from where a consumer left off; nothing resumes today.
- Text-only chunks do not carry binary content (image or PDF previews); those need an encoding decision when they move to the node.
- A protocol version change: server and node must restart together.
