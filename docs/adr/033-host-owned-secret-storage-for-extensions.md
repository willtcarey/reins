# ADR-033: Host-owned secret storage for backend extensions

**Status:** Accepted (amends 032)

## Context

The server SDK gave a backend extension `reins.secrets.encrypt`/`decrypt` with the server's key, and the extension kept the ciphertext where it liked. MCP kept it in its own table, `mcp_server_secrets`. With that design, each extension handles ciphertext and a key it does not own, makes its own secrets table and its own rules, and Reins cannot change where secrets are kept (an OS keychain, a secrets manager) without a change to each extension.

## Decision

- **A secret store that the host owns, scoped to each extension**, as VS Code's `SecretStorage` is: `reins.secrets` is `get(key)`, `set(key, value)`, `delete(key)` and `keys(prefix?)`. The values have names (keys of 1 to 256 characters, which the extension chooses, e.g. MCP's `servers/<id>/<kind>`), not opaque references. An extension sees only its own keys. The extension never handles ciphertext or the key.
- **Kept in the main database**, in the host's table `extension_secrets` (`extension`, `key`, `value`, `updated_at`), each value encrypted with the server's key (AES-256-GCM, `crypto.ts`), the key the core keeps its provider credentials with. They stay when an extension is no longer registered, as its directory does.
- **Async.** Every method returns a promise, also while the implementation is synchronous SQLite, so that a later implementation can do I/O (a keychain) without a change to the contract.
- **No transaction with the extension's database.** A secret write and a write to the extension's own database cannot be one transaction. The extension orders its writes so that a half-done change does no harm. MCP deletes a server's secrets before its row (a stop between them leaves a server without credentials, which the user sees, never secrets without a server), and a server whose secret cannot be stored when it is created is deleted again.
- **MCP's existing secrets are not migrated.** MCP's migration `002_host_secrets` adds `mcp_servers.oauth_tokens_issued_at` and drops `mcp_server_secrets` without moving its values. This had not rolled out: the only instance with MCP servers was moved once by a core migration (`062_move_mcp_secrets`, which copied the ciphertext as it was, since both are sealed with the same server key), removed afterwards. Its record was then deleted from that database.

## Options rejected

- **Keep `encrypt`/`decrypt`.** Each extension makes its own storage, and Reins cannot move secrets to another store.
- **Opaque references** (`set(value) → ref`, the extension keeps the reference). The extension must keep a reference beside each record and clean up those it loses; a named key under a prefix lets it find and delete a record's secrets with `keys(prefix)`.
- **A table in each extension's database.** The host would need to write into each extension's database, and an extension could read the ciphertext. The main database keeps all secrets in one place, which a later move to a keychain changes alone.
- **A synchronous API.** Simpler for MCP, which then had one transaction for a row and its secrets, but a keychain or remote store would need a breaking change.
- **An OS keychain now.** Not on every server (Docker, headless Linux), and the main database with the server key is what the core uses for its own credentials. It remains a possible later implementation behind the same contract.
- **AAD that binds a value to its extension and key.** It would stop a value from being moved to another key in the database, but the existing ciphertext has none, so MCP's move would need to decrypt. Someone who can write the database can also read the key next to it.

## Consequences

- A secret write and the extension's own writes can be half done; each extension must order them. MCP accepts this for its rows and secrets.
- Between an OAuth refresh's check that its tokens are still the stored ones and its write, a sign-out or a sign-in is no longer excluded by synchronous code: in that short window, the refresh's write can win. MCP accepts this.
- Secrets are in `reins.db`, extension data in `extensions/<name>/db.sqlite`: a backup is still the whole data directory.
- No change events (VS Code's `onDidChange`) yet: no extension needs them.
