# AgentHarness switchover

Not executed. Startup upgrade is still being implemented and reviewed.

1. Finish and review the isolated startup-upgrade implementation.
2. Preserve main-checkout changes; commit the complete tested release and record old/new commit IDs.
3. Stop the dev supervisor and all backend/session writers. Prevent automatic restarts.
4. Move the committed release into the main checkout **only after stopping it**: dev hot reload is unsafe across this change.
5. After verifying the old server and database users are stopped, start the new release normally with only the usual environment settings.
6. Bootstrap holds the cooperative process lock, creates and verifies an immutable WAL-consistent backup before mutation, runs ordinary schema migrations, then converts and validates history in one live-database transaction before services start. The lock and handle check do not fence arbitrary old binaries. Conversion failure rolls history back while completed schema migrations may remain; migration failure is restored explicitly from the backup.
7. Verify history, select an available utility model, and run an approved smoke prompt. Retired session models require explicit selection before resume.

**Rollback:** stop all writers; preserve failed-upgrade data; restore the paired old code and fresh pre-upgrade backup; verify integrity; restart. Post-upgrade messages are not automatically converted back.

Do not use an old test snapshot as production data. Do not put this data upgrade in `migrations.ts`.
