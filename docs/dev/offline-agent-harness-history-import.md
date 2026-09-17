# Offline AgentHarness history importer

`packages/backend/scripts/import-agent-harness-history.ts` converts a deliberately isolated copy of a Reins SQLite database to the AgentHarness storage format. It is not a startup migration, does not import Reins database initialization, and must never be pointed at the active database.

## Preconditions

- Stop before using real data until a separate copied-database dry run is authorized.
- The connection must have the required session/message/attachment columns, prepared by ordinary schema migrations before conversion. Validation checks actual schema objects and does not trust or require a historical migration marker.
- Legacy `harness_values`, `harness_list_values`, or `harness_usage` tables may remain only when empty. Any rows reject import rather than being ignored.
- Source and output must be distinct. The output and optional report must not exist.
- Every session requires a structurally valid explicit model mapping. The configuration includes exact identities exported from the installed Pi catalog; absent identities are retained and reported as runtime-unavailable rather than blocking structural migration.
- The only approved provider translation is `claude_agent_sdk` or `claude-agent-sdk` to `anthropic` with the same model ID. Catalog absence is reported as runtime-unavailable and does not alter the structural identity.

Configuration:

```json
{
  "catalog": [{ "provider": "anthropic", "modelId": "claude-opus-4-6" }],
  "sessions": {
    "session-id": {
      "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-6" },
      "activeToolNames": ["read", "write", "edit", "bash"]
    }
  }
}
```

`activeToolNames` defaults to the current real builder defaults shown above. Set it explicitly for sessions that used another tool set. Missing/invalid model identity and invalid thinking configuration reject the entire import. Catalog-unavailable identities are preserved in `unresolvedModels`; no substitute is selected. Successful migration sets `agent_runtime_type` to `pi` and stores the explicit target provider/model on the session. `default_model` and `utility_model` receive the same approved provider normalization and `runtimeType: "pi"`; unavailable setting identities are listed separately in `unresolvedSettings`.

## Invocation

```sh
bun packages/backend/scripts/import-agent-harness-history.ts \
  --source /isolated/source.db \
  --output /isolated/canonical.db \
  --config /isolated/model-map.json \
  --report /isolated/canonical-report.json
```

The importer first uses SQLite `VACUUM INTO` through a read-only source connection to create the output, then transforms only that output in one transaction. Copy acquisition and transformation share one cleanup scope, so an induced post-copy failure removes only the newly created output. The report hashes the immutable standalone snapshot and records whether WAL/SHM sidecars existed before opening it; a main-file hash is not presented as proof about an active WAL database. A failure removes the incomplete output. Existing or partially canonical data is rejected. The report contains only format version, hashes, aggregate counts, role counts, and SQLite integrity results; it contains no message text, paths, model credentials, or attachment data.

## Canonical mapping

- Existing integer message IDs, sequence numbers, parent relationships, timestamps, attachments, and displayed message content are retained. Physical role columns become canonical: `user` → `reinsInput`, `compactionSummary` → `compaction`, while `assistant` and `toolResult` remain unchanged.
- Any non-null legacy top-level message metadata rejects the complete import. The importer adds no metadata wrapper or unsupported entry/message property.
- Existing unique Pi logical IDs become harness IDs. Other IDs are deterministically derived from session ID plus immutable row ID.
- User rows become the supported `reinsInput` custom message, retaining attachment references. A nonempty legacy `clientMessageId` becomes the supported `reinsId`; otherwise `reinsId` uses the deterministic harness ID. Invalid client IDs reject import. Legacy `displayContent` is omitted only when exactly JSON-equal to `content`; differences reject import. The schema-required metadata object is empty.
- Assistant and tool-result rows remain native AgentHarness messages without extra properties.
- Compaction rows become `CompactionEntry` envelopes with `retainedTail: []` and `fromHook: false`. A present `tokensBefore` is preserved after validating it as a nonnegative safe integer; only an absent value defaults to zero. Legacy retained rows are already descendants. AgentHarness emits compaction summary + retained tail + descendants, so copying descendants into `retainedTail` would duplicate resumed context.
- The importer creates the required complete idle `main` lane values: branch tip, lane configuration, and lane state. It creates `pi_values`, `pi_lists`, and `pi_usage` on the isolated output when the provisional source schema has only empty legacy `harness_*` tables. It does not drop those empty legacy tables, duplicate session names into Pi values, or fabricate usage.

All stored rows remain archived UI history. For the explicitly legacy-linear source, the importer verifies that every non-null parent already equals the preceding `(seq, id)` row, rejects alternative non-null ancestry, and reconnects only detached null roots. The validated copy repairs 348 links across four sessions while preserving integer IDs and payloads. Resumed context then exactly matches the legacy latest-compaction sequence window. Fixture validation treats archive and active-context invariants separately.

The inspected source contains 25 session-wide genuinely orphaned tool-result rows, 24 in legacy active sequence windows. The importer deterministically deletes only a `toolResult` whose `toolCallId` is absent from every assistant tool call in the same session. It does not delete a result merely because its valid call lies outside the active compaction projection, and it preserves matched/reused IDs. Parent links are reconnected across deleted rows, sequence gaps remain, and the report lists exact deleted integer row IDs and reconnection count. No call rows are synthesized and no compatibility metadata is added.

The source also contains 844 unsigned thinking blocks (795 in Claude SDK sessions and 49 in Pi sessions). Archive data remains unchanged. The approved future-facing behavior is native Pi provider handling: `transformMessages` and the selected provider serializer decide whether an unsigned block is omitted, downgraded to text, or otherwise represented. There is no Claude-specific filter or importer flag.

## Proposed live backup procedure (not yet executed)

After separately coordinating writer quiescence, the proposed acquisition is SQLite's WAL-aware backup command, not filesystem copying:

```sh
sqlite3 /absolute/path/to/.reins/reins.db ".timeout 30000" ".backup '/isolated/reins-source.db'"
```

Then close the CLI, verify that the standalone snapshot has no WAL/SHM sidecars, hash `/isolated/reins-source.db`, run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and use that isolated file as `--source`. The importer additionally exercises read-only `VACUUM INTO` against disposable WAL fixtures, but the CLI `.backup` command is preferred for acquiring the first real isolated source because Bun exposes no documented online-backup API.

## Shared in-place upgrade API

Startup and the offline CLI share one connection-level flow. Neither function owns a transaction or imports application database startup:

```ts
const baseline = captureLegacyHistoryBaseline(db);
const conversion = convertLegacyAgentHarnessHistoryInPlace(db, config, baseline);
const validation = validateConvertedAgentHarnessHistory(db, baseline);
```

The converter rejects calls outside `db.inTransaction`. Startup owns one transaction containing baseline capture, conversion, and independent validation after its durable backup and ordinary schema migrations. Validation failure rolls back message conversion while earlier committed schema migrations remain. The baseline retains compact global/per-session hashes and expected IDs, not full transcripts or attachment payloads.

## Independent validation

The standalone validator does not import or reuse importer transforms. It opens explicit source/output paths read-only, performs all-row canonical archive comparisons, validates the approved linear ancestry repair, compares every active context in order, hashes attachment rows and BLOBs, checks lane counts and SQLite integrity, and emits no message content:

```sh
bun packages/backend/scripts/validate-agent-harness-history.ts \
  --source /isolated/reins-source.db \
  --output /isolated/canonical.db \
  --report /isolated/canonical-validation.json
```

The report path must not exist. Matching archive, active-context, and attachment hashes are required.
