# ADR-013: The Server Holds Provider Credentials and Is the Sole OAuth Refresher

- **Status:** Accepted
- **Date:** 2026-09-27
- **Author:** Will (with Claude)

## Context

Pi on each node needs provider credentials for every model request. The early node sketch had nodes hold the user's own API keys. OAuth logins rotate refresh tokens: if more than one process refreshes the same login, one of them invalidates the other's token. Credentials are managed in the app's settings UI, which the server serves.

## Decision

**The server is the only credential holder and the only OAuth refresher.** Nodes read credentials over the link and never persist them.

- `credentials.get` / `credentials.list` return the stored credential (no secrets in `list`); `credentials.refresh` runs Pi's own refresh against the server's credential store, serialized per provider for the whole process, so a login is refreshed at most once across nodes and the server.
- The wire shape carries access tokens and a fixed allowlist of non-secret OAuth fields; refresh tokens never leave the server (the schema rejects them).
- The node's `RemoteCredentialStore` caches in memory only, per provider, until the credential is no longer usable (OAuth tokens enter Pi's refresh window), and drops the cache on every new connection. Logins and logouts happen only on the server.

## Consequences

- A new node needs no credential configuration.
- A server-side logout or key change reaches a connected node only on reconnect (or the next OAuth refresh); there is no push.
- A node with no connection can keep using cached credentials but cannot refresh.
- Remote nodes must be enrolled and authenticated before these methods are served to them.
- Details: [node-contract.md](../dev/node-contract.md) *Credentials*.
