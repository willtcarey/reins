# ADR-032: A directory and a database for each backend extension

**Status:** Accepted

## Context

Backend extensions (docs/dev/server-sdk.md) got the server's main database through `reins.db`, and built-in extensions kept their tables in the core's migrations (MCP: `mcp_servers`, `mcp_server_secrets`, migrations `058` and `059`). That made an extension's schema the core's, let an extension read and write every core table, and gave an installable extension nowhere to keep its data. Extensions also had no directory of their own for files.

## Decision

- **A directory for each extension**, `<data dir>/extensions/<name>/`, given as `reins.dataDir` (absolute). The host creates it before the extension registers. The extension writes its files only there. Reins never deletes it.
- **A separate SQLite database for each extension**, `db.sqlite` in that directory, given as `reins.db`, opened as the main database is (WAL, foreign keys). Extensions no longer get the main database. Nothing in the SDK reaches it, and lint keeps an extension from importing `bun:sqlite`, so it cannot open one itself.
- **The SDK names the database type** (`Database` from `@reins/sdk/server`): for now an interface that extends `bun:sqlite`'s `Database` and adds nothing (the project's lint forbids a plain alias and a re-export). Extensions use only that name, so it can get Reins-owned members later without a change to their imports.
- **The process owns the connections** (`openExtensionData` in `database.ts`, `ServerProcess.extensionData`): opened at an extension's first registration and kept for the life of the process, as the main database is, so a dev reload keeps them.
- **Migrations declared by the extension**: `ServerExtension.migrations`, `[{ id, up(db) }]`, beside its register function. Before each registration, the host applies those not recorded in the extension's database (`reins_migrations`), in order, each in a transaction with its record. A failure is rolled back and reported as the extension's error, and that extension does not load in that app; Reins and the other extensions go on.
- **MCP moved:** its tables are its own migration `001_servers`. Core migration `060` copied the main database's rows into MCP's database (made the tables there from the main database's definitions, `INSERT OR IGNORE`, secrets still sealed with the server's key), then dropped them from the main database. The copy is best effort: a failure is logged and the tables are dropped all the same (the user can add the servers again).

## Options rejected

- **Prefixed tables in the main database** (`mcp_servers` under a `mcp_` rule). It keeps one file to back up, but an extension could still read and break the core's tables and other extensions', its schema would share the core's migration record, and it could not be moved, reset or removed alone.
- **A connection opened by each app.** A dev reload would open and close the file each time, and anything that outlives an app (a future service) would hold a closed connection.
- **MCP's own migration copying from the main database.** It needs the main database, which extensions no longer have. A core migration runs before any extension registers, so it makes MCP's tables itself; MCP's `001_servers` uses `IF NOT EXISTS` for that.

## Consequences

- A backup is the whole data directory, not `reins.db` only.
- `reins.db` is still `bun:sqlite`'s `Database` (the SDK's interface extends it): an extension must run in the Bun server process and use Bun's API, and one outside the process could not use it. A Reins-owned interface comes with the loader.
- A migration that has shipped must not change. The host does not check that the recorded migrations still match the list.
- Core code may not reach an extension's database. The `060` move is the only exception: it is history.
