# Session message persistence

## Canonical ownership

AgentHarness is the only transcript writer, through `PiStorageAdapter` (`@reins/pi-sql-storage`), which stores each public harness `Entry` in `session_messages`; Reins does not persist runtime snapshots or maintain a second replay transcript. The same tables exist in two places:

- **On the node** (`~/.reins/node/storage.db`, separate from the server data directory): canonical storage for the sessions placed on it. Each Pi commit also records its exact write batch in the node's ordered outbox, and the node delivers it to the server as `session.committed`. A delivery failure never fails the commit: the batch waits and replays on the next commit, report or connection.
- **On the server** (`REINS_DATA_DIR/reins.db`): a replica of every session, applied batch by batch in sequence (`node-replica.ts`, watermarked by `sessions.harness_next_seq`), read by history, tree, search and context readers. It is canonical only for a session at rest on the server (`placement_status = 'server'`), which the server never runs: its next use hydrates it onto its node. The server writes Pi tables only by applying replica batches.

Server reads may lag the node while delivery is pending. Never reconstruct node state from the server's display projection; moving a session copies the server's rows verbatim (see [node-contract.md](node-contract.md) *Session relocation*).

- `session_messages.id` is the stable UI row identity.
- `harness_id` is the exact AgentHarness entry identity.
- `parent_id` stores actual ancestry.
- `seq` is the global harness write sequence; gaps are expected.
- `message_json` is the canonical PiStorageAdapter entry envelope.
- `pi_values`, `pi_lists`, and `pi_usage` store the remaining harness contract state. `pi_usage` includes both assistant-linked provider calls and standalone structural calls and supports cumulative statistics. Current context occupancy instead uses usage embedded in valid assistant messages on the active branch, so structural requests cannot be mistaken for occupancy.

Canonical readers do not accept legacy `RuntimeMessage` JSON. The one-time legacy history importer and its startup format check have been retired; backend startup runs normal schema migrations without scanning existing AgentHarness history. An empty, unprovisioned node-owned server replica has no lane values until node writes are delivered.

## Archive and active history

Archive display and active execution are deliberately separate projections.

`loadMessages()`, message pages, session search, and timeline entries project every message or compaction entry in sequence order. Message pages expose the same canonical `ConversationEntry` envelope as durable WebSocket events: AgentHarness `id`, AgentHarness `parentId`, global harness `seq`, optional Reins `clientId`, and a content-only message. SQLite row IDs remain an internal ancestry implementation detail. The `clientId` is the stored Reins input `reinsId`, allowing optimistic input reconciliation without FIFO, content, role, or timestamp inference. Custom and branch-summary entries are not chat records.

Closed-session results follow `pi.branch.tip/main` ancestry through `loadActiveMessages()`. They do not select a newer archived branch merely because it has a greater sequence. Open runtimes obtain context through AgentHarness branch traversal. After compaction, context is the latest summary, its retained tail, and descendants; archive readers still show older rows.

Runtime provider projection has no orphan compatibility filter: it projects canonical history directly, without fabricating calls, migration flags, or runtime codecs. Historical thinking blocks, including unsigned blocks from older canonical sessions, are passed unchanged to Pi's native provider serialization; provider-specific serializers may handle them differently.

## Lifecycle effects

Run lifecycle reaches the server as durable `session.started`/`session.settled` reports (see [node-runtime.md](node-runtime.md) *Lifecycle reports*). They store activity and final model/thinking metadata only; live runtime events are only broadcast. At settlement, top-level sessions become finished/unread; a child's result is queued to its parent in the same transaction and the child clears to idle; if the reply cannot be read or delivered, the child falls back to finished/unread. No lifecycle effect writes a transcript checkpoint.

A child's reported result is read by the node from its canonical active branch at settlement. Passive reopened operations are returned by AgentHarness but are not driven automatically.

## Attachments and metadata

Entries retain Reins attachment references. The server retains bytes in `session_attachments` for browser history and hydration. For input images, the node fetches the bytes with `attachment.fetch`, verifies them once before Pi admission, caches them in node SQLite (`node_attachments`) and hydrates synchronously from that cache at the provider boundary. Failed multi-image inputs can leave verified bytes cached without admitting any input. Opening a runtime does not fetch historical bytes; uncached historical references become provider placeholders. Tool-result images are cached on the node under node-assigned IDs and uploaded to the server (`attachment.store`) before any commit that references them. See node-contract.md *Attachments*.

Reins-owned input entries carry their stable `reinsId` and application metadata inside the supported `reinsInput` custom message. For browser prompt and steer commands, `reinsId` is the client-generated request ID carried by the optimistic entry and canonical durable envelope; retries therefore resolve to the same durable input rather than a second transcript entry. Canonical AgentHarness `entry_added` delivery is the only peer conversation notification; there is no separate user-message broadcast or transcript fallback. Metadata and identity are supplied when AgentHarness durably accepts the prompt; there is no post-hoc transcript mutation API or compatibility side table. Cross-session inputs use only `metadata.sourceSessionId`, while their content remains clean. Archive, active-runtime, and live-delivery projections preserve that metadata for recipient rendering. The provider projection alone frames sourced content as a Reins session update that is not new user authorization. Historical inputs without application metadata retain an empty metadata object.

Some historical model IDs and the imported utility-model ID may not exist in the installed catalog. They remain visible as historical identity and must be replaced explicitly in Settings or through the inactive-session model picker; no fallback is selected.

## Retired models

Archive reads do not open a runtime. An inactive session with an unavailable stored model can be updated through the existing session model route before it is opened. Selection validates the exact provider/model against the registered Pi catalog; runtime construction never silently substitutes a model.
