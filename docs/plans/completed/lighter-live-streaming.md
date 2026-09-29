# Lighter live streaming

## Problem

Live agent output looks chunky: text arrives in bursts, and several tool calls show up at once. Every per-token `message_update` costs time proportional to the message size, and sometimes to the whole transcript, at every hop:

- **Node.** `mapHarnessEvent` sends the full message snapshot in `message`. Pi's `assistantMessageEvent` also carries `partial`, a second full snapshot. `sendableEvent` runs the `sessionEvent` schema over both, recursively walking every key to find images, then stringifies them.
- **Server.** It parses the frame. The peer then validates `sessionEventParams`, which walks the images again. `notify` parses the same params a second time, for a third walk. There is a `getSession` lookup, then `createBroadcast` stringifies again and sends the result to every connected browser.
- **Browser.** For each event, `ConversationsStore.handleEvent` maps every transcript entry into a `messages` array that `applyChatEvent` never reads. `update` copies the pending-submissions Map and builds a Set of all entry IDs, then notifies listeners. `get()` rebuilds `buildMessages` over the whole transcript. The chat panel re-renders, and `<markdown-content>` re-parses the entire streaming message with `marked` and replaces its DOM through `unsafeHTML`.

When the main thread falls behind, WebSocket messages pile up and get painted together.

## Direction

Keep token-by-token streaming, and make each token cheap.

- Events stay recognisably Pi's: same event types, same `assistantMessageEvent` deltas. Only the redundant snapshots are dropped.
- Live events stay best effort. Durable state still comes from `session.committed` / `entry_added`.
- The server relays events without reading the payload.
- The browser applies deltas as they arrive and paints at most once per animation frame. That is still token-by-token to the eye.
- Streaming tool-call arguments and streaming tool results should work the same way later, so this design must not rule them out.

We are not copying bb's model: coalescing into ~100ms chunks, storing chunks, and refetching timeline rows on invalidation. It gives up the token-by-token feel.

## Stages

### 1. Measure

Add a `streaming` scope to dev client telemetry ([client-telemetry.md](../../dev/client-telemetry.md)). Per `streamId`, record:

- events received per frame
- time from WebSocket receipt to paint
- `chat-panel` render duration
- `<markdown-content>` parse duration
- message size

Capture a baseline from a long assistant message in a long session, then capture again after each stage.

### 2. Cheaper frontend with today's wire format

This stage is independent of the protocol, so it helps immediately.

- **Stop dead work in `handleEvent`.** Stop building the unused `messages` array. Drop `messages` from `ChatState` if nothing reads it.
- **Memoize the transcript view.** `ConversationView.messages` is rebuilt only when `entries` or `pendingSubmissions` change. A streaming update then leaves every transcript `Message` object identical, and `repeat` does not update those rows.
- **Batch notifications per frame.** Events are applied to state immediately, but `ConversationsStore` notifies listeners once per animation frame per session. Provide a synchronous flush for tests and for boundaries that must not wait, such as `message_end`, `agent_end` and `entry_added`, if ordering requires it.
- **Streaming markdown split.**
  - While `streaming` is true, `<markdown-content>` splits the text at the last safe block boundary. A safe boundary is a blank line outside a fenced code block, `$$` math or an open list.
  - The settled prefix renders through one inner renderer whose text rarely changes, so Lit skips the re-parse. Only the live tail is re-parsed.
  - When streaming ends, render the whole text unsplit. That output is authoritative.
  - Test that the prefix+tail output matches the unsplit output at every chunk boundary, for common shapes: paragraphs, lists, fences, tables and headings.

Event frames keep going to every connected browser. Clients that are not showing a session must keep their handling of its events cheap: apply the event to state and skip the render.

### 3. Thin `message_update` on the wire

- **Node** (`runtime/pi-runtime.ts`). `message_update` becomes `{type, streamId, assistantMessageEvent}`, where `assistantMessageEvent` is Pi's event with `partial` removed.
  - `message` is included only as a **keyframe**: the stream's first update after `message_start`, then at most about once per second per stream.
  - `message_start` and `message_end` keep their full snapshots.
  - `text_end`, `thinking_end` and `toolcall_end` already carry their block's final content.
- **Protocol** (`node-protocol/events.ts`). `message_update.message` becomes optional. Session-event `seq` is forwarded to browsers, so a client can detect gaps.
- **Browser** (`chat-state.ts`). Changes to `upsertAssistantSnapshot`:
  - A `message` on the event replaces the overlay.
  - Otherwise, apply the delta to the overlay's `content[contentIndex]`:
    - `text_*` and `thinking_*` append.
    - `toolcall_start` / `toolcall_delta` build up the raw argument JSON string on the block. The parsed `arguments` stay unchanged until `toolcall_end`. That raw string is the groundwork for streaming tool-call previews later.
  - A delta for an unknown stream, a `seq` gap, or a WebSocket reconnect marks the overlay stale. Its content is kept and later deltas are ignored until the next keyframe or `message_end`. A browser that opens mid-message sees content at the next keyframe, within about a second.

### 4. Opaque relay on the server

- **Wire.** `session.event` params carry `event` as a string: JSON the node serialised once, after `sendableEvent` swapped inline images for placeholders. The server validates only the envelope: epoch, sessionId and seq. Bump `protocolVersion`.
- **Server.** `nodeSessionReports.event` builds the browser frame by concatenating strings around the raw event. There is no parse, schema walk or re-stringify of the payload. Cache `projectId` per session instead of calling `getSession` per event. The cache is invalidated on session delete or move.
- **Tradeoff.** The server no longer enforces "no inline image bytes in events". That guarantee rests on the node's `sendableEvent`. Update the *Attachments* and `session.event` sections of [node-contract.md](../../dev/node-contract.md).
- **Node image walk.** Scan only the events that can carry images: tool results and `tool_execution_update` partial results. Assistant text deltas skip the walk.

## Later

- **Streaming tool-call previews.** Parse the accumulated raw argument JSON leniently for renderers that opt in, for example showing a `write` tool's content as it streams.
- **Streaming tool results.** `tool_execution_update.partialResult` is cumulative. Give it the same keyframe-plus-delta treatment, by diffing on the node, before rendering it live.

## Open questions

- Keyframe interval: about 1s, or based on bytes, such as every N KB of delta?
- Should frame-batched notification also apply to `tool_execution_*` events, or only to message streams?
- Does the markdown split need a max tail size? A single huge paragraph never settles.
