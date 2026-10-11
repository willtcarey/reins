# Session message persistence

## Canonical ownership

AgentHarness is the only transcript writer, through `PiStorageAdapter` (`packages/backend/src/pi-storage.ts`), which stores each public harness `Entry` in `session_messages`; Reins does not persist runtime snapshots or maintain a second replay transcript. **The server's database (`REINS_DATA_DIR/reins.db`) holds the only copy** ([ADR-015](../adr/015-server-canonical-storage-stateless-node.md), [ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md)): a session's runtime runs on the server and reads and commits through a `PiStorageAdapter` on the process's database connection, Pi running its commit validation there (see [session-runtime.md](session-runtime.md) *Assembly*). History, tree, search and context readers read the same tables. Only a session's runtime writes Pi tables. A commit that fails fails the run (the runtime settles it failed and is reopened from storage for the next submission); there is no other copy to reconcile.

- `session_messages.id` is the stable UI row identity.
- `harness_id` is the exact AgentHarness entry identity.
- `parent_id` stores actual ancestry.
- `seq` is the global harness write sequence; gaps are expected.
- `message_json` is the canonical PiStorageAdapter entry envelope.
- `pi_values`, `pi_lists`, and `pi_usage` store the remaining harness contract state. `pi_usage` includes both assistant-linked provider calls and standalone structural calls and supports cumulative statistics. Current context occupancy instead uses usage embedded in valid assistant messages on the active branch, so structural requests cannot be mistaken for occupancy.

Canonical readers do not accept legacy `RuntimeMessage` JSON. The one-time legacy history importer and its startup format check have been retired; backend startup runs normal schema migrations without scanning existing AgentHarness history. A session that never ran has no lane values: Pi creates its lane when its runtime first opens.

## Archive and active history

Archive display and active execution are deliberately separate projections.

`loadMessages()`, message pages, session search, and timeline entries project every message or compaction entry in sequence order. Message pages expose the same canonical `ConversationEntry` envelope as durable WebSocket events: AgentHarness `id`, AgentHarness `parentId`, global harness `seq`, optional Reins `clientId`, and a content-only message. SQLite row IDs remain an internal ancestry implementation detail. The `clientId` is the stored Reins input `reinsId`, allowing optimistic input reconciliation without FIFO, content, role, or timestamp inference. Custom and branch-summary entries are not chat records.

Closed-session results follow `pi.branch.tip/main` ancestry through `loadActiveMessages()`. They do not select a newer archived branch merely because it has a greater sequence. Open runtimes obtain context through AgentHarness branch traversal. After compaction, context is the latest summary, its retained tail, and descendants; archive readers still show older rows.

Runtime provider projection has no orphan compatibility filter: it projects canonical history directly, without fabricating calls, migration flags, or runtime codecs. Historical thinking blocks, including unsigned blocks from older canonical sessions, are passed unchanged to Pi's native provider serialization; provider-specific serializers may handle them differently.

## Lifecycle effects

A runtime reports its run's lifecycle (`started`, `settled`) to the server's run records (see [session-runtime.md](session-runtime.md) *Lifecycle and child reports*). They store activity and final model/thinking metadata only; live runtime events are only broadcast. At settlement, top-level sessions become finished/unread; a child's result is first steered to its parent (committed by the parent's runtime, under a key derived from the child's settlement), then the settlement is committed and the child clears to idle; if the reply cannot be read or delivered, the child falls back to finished/unread. No lifecycle effect writes a transcript checkpoint.

A child's result is projected on the server through `loadBranchMessages(sessionId, tipId)`, using the committed branch tip Pi captured in `run_end`. A delayed report never substitutes the latest main tip. Passive reopened operations are returned by AgentHarness but are not driven automatically.

## Attachments and metadata

Entries retain Reins attachment references. The server retains bytes in `session_attachments` for browser history and hydration. For input images, a session's runtime reads the bytes from the store, verifies them once before Pi admission, caches them in memory and hydrates from that cache at the provider boundary, reading historical references it has not cached then; one the store no longer holds becomes a provider placeholder. Tool-result images are stored under runtime-assigned IDs before any commit references them. See session-runtime.md *Images*.

Reins-owned input entries carry their stable `reinsId` and application metadata inside the supported `reinsInput` custom message. For browser prompt and steer commands, `reinsId` is the client-generated request ID carried by the optimistic entry and canonical durable envelope; retries therefore resolve to the same durable input rather than a second transcript entry. Canonical AgentHarness `entry_added` delivery is the only peer conversation notification; there is no separate user-message broadcast or transcript fallback. Metadata and identity are supplied when AgentHarness durably accepts the prompt; there is no post-hoc transcript mutation API or compatibility side table. Cross-session inputs use only `metadata.sourceSessionId`, while their content remains clean. Archive, active-runtime, and live-delivery projections preserve that metadata for recipient rendering. The provider projection alone frames sourced content as a Reins session update that is not new user authorization. Historical inputs without application metadata retain an empty metadata object.

Some historical model IDs and the imported utility-model ID may not exist in the installed catalog. They remain visible as historical identity and must be replaced explicitly in Settings or through the inactive-session model picker; no fallback is selected.

## Retired models

Archive reads do not open a runtime. An inactive session with an unavailable stored model can be updated through the existing session model route before it is opened. Selection validates the exact provider/model against the registered Pi catalog; runtime construction never silently substitutes a model.
