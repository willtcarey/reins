# Session message persistence

## Canonical ownership

AgentHarness is the only transcript writer. `PiStorageAdapter` stores each public harness `Entry` in `session_messages`; Reins does not persist runtime snapshots or maintain a second replay transcript.

- `session_messages.id` is the stable UI row identity.
- `harness_id` is the exact AgentHarness entry identity.
- `parent_id` stores actual ancestry.
- `seq` is the global harness write sequence; gaps are expected.
- `message_json` is the canonical PiStorageAdapter entry envelope.
- `pi_values`, `pi_lists`, and `pi_usage` store the remaining harness contract state.

Canonical readers do not accept legacy `RuntimeMessage` JSON. Process bootstrap inspects the database before importing application handlers or calling `getDb()`. After the operator stops the old server and all database users, startup creates an immutable WAL-consistent backup of the original schema, runs ordinary schema migrations, then converts and validates legacy history in one transaction on the live database. Fresh installs continue normally and canonical databases are not reconverted. Conversion failure rolls history back, though completed backward-compatible schema migrations may remain; migration failure requires explicit backup restoration. The cooperative lock and open-handle check do not fence arbitrary old binaries. See the cutover runbook for recovery details.

## Archive and active history

Archive display and active execution are deliberately separate projections.

`loadMessages()`, message pages, session search, and timeline entries project every message or compaction entry in sequence order. Message pages retain SQLite row IDs and stored parent row IDs. Custom and branch-summary entries are not chat records.

Closed-session results follow `pi.branch.tip/main` ancestry through `loadActiveMessages()`. They do not select a newer archived branch merely because it has a greater sequence. Open runtimes obtain context through AgentHarness branch traversal. After compaction, context is the latest summary, its retained tail, and descendants; archive readers still show older rows.

The one-time offline importer removes the specifically validated legacy tool-result rows that have no genuine matching call from canonical output. Runtime provider projection has no orphan compatibility filter: it projects clean canonical history directly, without fabricating calls, migration flags, or runtime codecs. Historical thinking blocks, including unsigned blocks imported from Claude history, are passed unchanged to Pi's native provider serialization; provider-specific serializers may handle them differently.

## Lifecycle observers

The runtime observer stores activity and final model/thinking metadata only. Running activity remains immediate. Terminal activity and parent settlement reporting are ordered through the observer's `flush()` handle. The observer never calls `getMessages()` to write a checkpoint.

Parent reports wait for lifecycle handling, then derive their result from the child's live canonical runtime branch. Passive reopened operations are returned by AgentHarness but are not driven automatically.

## Attachments and metadata

Entries retain Reins attachment references. Bytes remain in `session_attachments` and are hydrated only at the provider boundary.

Reins-owned input entries carry their stable `reinsId` and application metadata inside the supported `reinsInput` custom message. Metadata is supplied when AgentHarness durably accepts the prompt; there is no post-hoc transcript mutation API or compatibility side table. Cross-session inputs use only `metadata.sourceSessionId`, while their content remains clean. Archive, active-runtime, and live-delivery projections preserve that metadata for recipient rendering. The provider projection alone frames sourced content as a Reins session update that is not new user authorization. The approved legacy import has no application metadata, so imported input metadata starts empty.

Some historical model IDs and the imported utility-model ID may not exist in the installed catalog. They remain visible as historical identity and must be replaced explicitly in Settings or through the inactive-session model picker; no fallback is selected.

## Retired models

Archive reads do not open a runtime. An inactive session with an unavailable stored model can be updated through the existing session model route before it is opened. Selection validates the exact provider/model against the registered Pi catalog; runtime construction never silently substitutes a model.
