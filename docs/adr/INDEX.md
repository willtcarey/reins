# Architecture Decision Records

Record an ADR when a library/tool/approach is **evaluated and rejected**, a **significant architectural choice** is made, or an existing decision is **revisited or reversed**. Use the format `NNN-slug.md`.

| ADR | Status | Summary |
|-----|--------|---------|
| [001](001-pierre-diffs.md) | Rejected | Evaluated `@pierre/diffs` for diff viewer — rejected twice |
| [002](002-sqlite-sessions.md) | Proposed | Persist sessions and messages in SQLite |
| [003](003-pi-sdk-for-all-llm-calls.md) | Accepted | Route all LLM calls through Pi SDK sessions |
| [004](004-sqlite-utc-timestamps.md) | Accepted | SQLite timestamps must include UTC `Z` suffix |
| [005](005-orchestrator-loop-not-relay-chain.md) | Accepted | Use orchestrator loop, not relay chain, for multi-step delegation |
