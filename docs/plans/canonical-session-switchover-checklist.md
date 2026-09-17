# Canonical session switchover checklist

Status: **preparation only — do not activate**

## Preconditions

- [ ] Stop all production writers and verify no backend/watch process can reopen the database.
- [ ] Take and hash a WAL-consistent SQLite backup; never copy only `reins.db` while writers run.
- [ ] Preserve the untouched source and importer report for rollback.
- [ ] Run the standalone importer only against distinct isolated source/output paths.
- [ ] Verify actual output schema, not only migration markers: correct `pi_values`, `pi_lists`, `pi_usage`, `harness_next_seq`, `harness_id`, ancestry constraints and indexes; no nonempty provisional harness tables.
- [ ] Confirm every session runtime is `pi`.
- [ ] Confirm mapped provider/model identities against the exact installed Pi catalog. Record unavailable historical session/default/utility IDs without substituting them.
- [ ] Confirm every session has complete `main` branch tip/config/state values, including empty sessions.
- [ ] Run `foreign_key_check`, `integrity_check`, adapter scans, and importer count/hash comparisons.

## Isolated validation

- [ ] Use a separate checkout/process and disposable `REINS_DATA_DIR`.
- [ ] Set isolated `HOME`, `USERPROFILE`, and XDG roots before importing application modules.
- [ ] Clear provider credential environment variables and enable offline behavior.
- [ ] Use fake providers only; do not print credential rows, messages, or attachment bytes.
- [ ] Verify archive pagination/search, row IDs, parent links, tool expansion, attachment references, compaction display, and active branch outcomes.
- [ ] Reopen representative empty, compacted, parented, Claude-imported, and Pi-imported sessions.
- [ ] Verify unavailable-model sessions remain archive-readable and can be updated while inactive before runtime open.
- [ ] Verify prompts create only canonical entry writes and no snapshot update/delete statements.
- [ ] Verify the importer reports legacy unmatched-result cases, removes only the approved genuine orphan rows from canonical output, and leaves no runtime/provider orphan filter. Verify imported thinking blocks pass unchanged to native Pi serialization.
- [ ] Verify parent settlement reports after the synchronous lifecycle update and passive operations do not auto-drive.
- [ ] Run focused tests, full test suite, typecheck, and lint.

## Switchover — requires separate authorization

- [ ] Reconfirm production remains stopped.
- [ ] Atomically replace the database with the validated imported output, retaining source and WAL-safe backup.
- [ ] Deploy importer-compatible canonical reader/runtime code as one unit.
- [ ] Start exactly one backend process and inspect health without prompting sessions.
- [ ] Verify archive reads and model updates before allowing execution.
- [ ] Perform one explicitly approved fake/non-sensitive smoke session, then enable normal access.

## Rollback

- [ ] Stop the canonical backend immediately; do not run old code against canonical rows.
- [ ] Preserve the failed canonical database and logs for diagnosis.
- [ ] Restore the untouched pre-import backup atomically, including correct WAL handling.
- [ ] Restore the previous application build before starting writers.
- [ ] Verify integrity and session counts before reopening access.

No rollback step converts canonical writes back into legacy snapshots. Rollback restores the paired pre-cutover application and database backup.
