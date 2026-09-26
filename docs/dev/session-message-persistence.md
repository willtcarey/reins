# Session message persistence

## Canonical ownership

AgentHarness is the only transcript writer. `PiStorageAdapter` stores each public harness `Entry` in `session_messages`; Reins does not persist runtime snapshots or maintain a second replay transcript.

- `session_messages.id` is the stable UI row identity.
- `harness_id` is the exact AgentHarness entry identity.
- `parent_id` stores actual ancestry.
- `seq` is the global harness write sequence; gaps are expected.
- `message_json` is the canonical PiStorageAdapter entry envelope.
- `pi_values`, `pi_lists`, and `pi_usage` store the remaining harness contract state. `pi_usage` includes both assistant-linked provider calls and standalone structural calls and supports cumulative statistics. Current context occupancy instead uses usage embedded in valid assistant messages on the active branch, so structural requests cannot be mistaken for occupancy.

Canonical readers do not accept legacy `RuntimeMessage` JSON. Process bootstrap checks existing databases read-only before application initialization or schema migrations. A fresh data directory proceeds normally; an unsupported legacy or invalid history format fails startup without modifying the database. The one-time legacy history importer has been retired.

## Archive and active history

Archive display and active execution are deliberately separate projections.

`loadMessages()`, message pages, session search, and timeline entries project every message or compaction entry in sequence order. Message pages expose the same canonical `ConversationEntry` envelope as durable WebSocket events: AgentHarness `id`, AgentHarness `parentId`, global harness `seq`, optional Reins `clientId`, and a content-only message. SQLite row IDs remain an internal ancestry implementation detail. The `clientId` is the stored Reins input `reinsId`, allowing optimistic input reconciliation without FIFO, content, role, or timestamp inference. Custom and branch-summary entries are not chat records.

Closed-session results follow `pi.branch.tip/main` ancestry through `loadActiveMessages()`. They do not select a newer archived branch merely because it has a greater sequence. Open runtimes obtain context through AgentHarness branch traversal. After compaction, context is the latest summary, its retained tail, and descendants; archive readers still show older rows.

Runtime provider projection has no orphan compatibility filter: it projects canonical history directly, without fabricating calls, migration flags, or runtime codecs. Historical thinking blocks, including unsigned blocks from older canonical sessions, are passed unchanged to Pi's native provider serialization; provider-specific serializers may handle them differently.

## Lifecycle observers

The runtime lifecycle sink stores activity and final model/thinking metadata only; the broadcast observer only projects runtime events. Running activity remains immediate. At terminal settlement, top-level sessions become finished/unread. Child sessions remain running while their canonical result is delivered to the parent, then clear directly to idle after native inbox admission; failed or invalid parent delivery falls back to finished/unread. The lifecycle sink never calls `getMessages()` to write a checkpoint.

Parent reports derive their result from the child's live canonical runtime branch and use the authoritative terminal outcome. Passive reopened operations are returned by AgentHarness but are not driven automatically.

## Attachments and metadata

Entries retain Reins attachment references. Bytes remain in `session_attachments` and are hydrated only at the provider boundary.

Reins-owned input entries carry their stable `reinsId` and application metadata inside the supported `reinsInput` custom message. For browser prompt and steer commands, `reinsId` is the client-generated request ID carried by the optimistic entry and canonical durable envelope; retries therefore resolve to the same durable input rather than a second transcript entry. Canonical AgentHarness `entry_added` delivery is the only peer conversation notification; there is no separate user-message broadcast or transcript fallback. Metadata and identity are supplied when AgentHarness durably accepts the prompt; there is no post-hoc transcript mutation API or compatibility side table. Cross-session inputs use only `metadata.sourceSessionId`, while their content remains clean. Archive, active-runtime, and live-delivery projections preserve that metadata for recipient rendering. The provider projection alone frames sourced content as a Reins session update that is not new user authorization. Historical inputs without application metadata retain an empty metadata object.

Some historical model IDs and the imported utility-model ID may not exist in the installed catalog. They remain visible as historical identity and must be replaced explicitly in Settings or through the inactive-session model picker; no fallback is selected.

## Retired models

Archive reads do not open a runtime. An inactive session with an unavailable stored model can be updated through the existing session model route before it is opened. Selection validates the exact provider/model against the registered Pi catalog; runtime construction never silently substitutes a model.
