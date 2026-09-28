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
| [008](008-server-hub-session-relocation.md) | Accepted | Relocate sessions by hydrating the server's copy onto the target node; no release or node-to-node transfer |
| [009](009-node-canonical-storage-server-replica.md) | Accepted | The running node owns canonical session storage; the server keeps an exact ordered replica |
| [010](010-state-derived-idempotency.md) | Accepted | Derive replay idempotency from resulting state; no receipt tables |
| [011](011-placement-status-single-source-of-truth.md) | Accepted | `placement_status` is the single source of truth for where a session lives |
| [012](012-ndjson-unix-socket-local-link.md) | Accepted | NDJSON JSON-RPC over a permission-protected Unix socket for the local node link |
| [013](013-server-holds-credentials.md) | Accepted | The server holds provider credentials and is the sole OAuth refresher |
