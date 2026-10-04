# Architecture Decision Records

Record an ADR when a library/tool/approach is **evaluated and rejected**, a **significant architectural choice** is made, or an existing decision is **revisited or reversed**. Use the format `NNN-slug.md`.

| ADR | Status | Summary |
|-----|--------|---------|
| [001](001-pierre-diffs.md) | Accepted | Use `@pierre/diffs` inside the Reins-owned bounded review surface |
| [002](002-sqlite-sessions.md) | Proposed | Persist sessions and messages in SQLite |
| [003](003-pi-sdk-for-all-llm-calls.md) | Accepted | Route all LLM calls through Pi SDK sessions |
| [004](004-sqlite-utc-timestamps.md) | Accepted | SQLite timestamps must include UTC `Z` suffix |
| [005](005-orchestrator-loop-not-relay-chain.md) | Accepted | Use orchestrator loop, not relay chain, for multi-step delegation |
| [006](006-acpx-as-runtime-replacement.md) | Rejected | Evaluated acpx as a universal runtime replacement; keep Reins runtime contract |
| [007](007-durable-stream-protocol.md) | Rejected | Evaluated Durable Streams for runtime replay; keep WebSockets and canonical message persistence |
| [008](008-server-hub-session-relocation.md) | Superseded by 015 | Relocate sessions by hydrating the server's copy onto the target node; no release or node-to-node transfer |
| [009](009-node-canonical-storage-server-replica.md) | Superseded by 015 | The running node owns canonical session storage; the server keeps an exact ordered replica |
| [010](010-state-derived-idempotency.md) | Accepted (narrowed by 015) | Derive replay idempotency from resulting state; no receipt tables |
| [011](011-placement-status-single-source-of-truth.md) | Superseded by 015 | `placement_status` is the single source of truth for where a session lives |
| [012](012-ndjson-unix-socket-local-link.md) | Accepted | NDJSON JSON-RPC over a permission-protected Unix socket for the local node link |
| [013](013-server-holds-credentials.md) | Accepted | The server holds provider credentials and is the sole OAuth refresher |
| [014](014-shared-protocol-and-storage-packages.md) | Accepted (pi-sql-storage folded back into the backend under 015) | The server does not depend on the node package; the link lives in `@reins/node-protocol` (Pi SQLite storage was `@reins/pi-sql-storage` until 015) |
| [015](015-server-canonical-storage-stateless-node.md) | Accepted | The server's SQLite is the only canonical session storage; the node forwards every read and commit over the link and holds no durable state |
| [016](016-process-owned-node-hub.md) | Accepted | Process-owned node links/dispatch survive product-handler reload; protocol changes require coordinated restart; child replies project from captured branch tips |
| [017](017-node-link-streams.md) | Accepted (binary chunks added by 018) | Node→server streams with server-allocated IDs and absolute offsets; local backpressure (paced by socket drain, capped server buffer), no credit protocol |
| [018](018-process-run-and-fs-methods.md) | Accepted | Git runs on the node through a generic `process.run` stream (argv, no shell) with the git logic kept on the server; file-browser reads are typed `fs.*` methods |
| [019](019-server-generated-system-prompt-and-session-kinds.md) | Accepted | The server generates the Reins part of the system prompt and the node appends its environment; sessions have kinds (prompt, tools, environment) resolved by the server and sent in opening commands |
