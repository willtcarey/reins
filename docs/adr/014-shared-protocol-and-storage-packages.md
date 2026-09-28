# ADR-014: The Server Does Not Depend on the Node Package; Shared Code Lives in Two Packages

- **Status:** Accepted
- **Date:** 2026-09-28
- **Author:** Will (with Claude)

## Context

The server imported the node package for everything the two sides share: wire schemas and the RPC peer, the outbox command vocabulary, the Pi SQLite storage it replicates into, Reins tool types, the final-reply helper, and even node runtime code (its own Pi model context from `@reins/node/runtime`, skill discovery from `@reins/node/resources`). The node package was therefore both "the node" and "the library both sides link", so node-only changes could reach the server's bundle, and the boundary between the processes was a list of allowed subpaths rather than a package edge. Remote nodes will make the link the only thing the two sides share.

## Decision

**Split what both sides use into two packages; the server imports nothing from `@reins/node`.**

- `@reins/node-protocol`: everything about talking over the link, definitions and plumbing alike — command vocabulary, wire schemas and method names, capabilities, error codes, runtime event shapes, Reins tool call surface, JSON-RPC peer, NDJSON Unix-socket framing, local-link constants, the node end of a connection, and an in-memory loopback under `/testing`. It depends only on `zod`, so either side (and a future remote node) can take it without Pi or SQLite.
- `@reins/pi-sql-storage`: Pi's storage on SQLite and snapshot paging/digests, one implementation for the node's canonical copy and the server's replica. It depends only on Pi, not on the protocol (the snapshot row shape is its own; the wire schema validates the same shape).
- `@reins/node` keeps node-only code (runtime, tools, resources, node API, storage for node-only tables, process entry).
- The server builds its own Pi model context from Pi with its credential store, and reads a source's skills from its node over a new request, `skills.list`.
- Oxlint rules and a test enforce it: backend production code may not import `@reins/node` or `@reins/node/*`; node-protocol imports only zod; pi-sql-storage imports only Pi. The dormant Claude runtime (`runtimes/claude_agent_sdk/`, unreachable from the server entry) is the one documented exception until it is rebuilt on the node.

Rejected: one shared package for protocol and storage (it would drag Pi and SQLite into anything that only speaks the protocol); keeping the shared code in `@reins/node` behind an allowlist of exports (the rule this replaces: it kept the dependency edge and let node runtime code into the server).

## Consequences

- A node code change no longer reloads the server; changes to the shared packages reload both (see [hot-reload.md](../dev/hot-reload.md)).
- Skill suggestions depend on the source's node being connected; offline, the route answers an empty list flagged unavailable and the UI keeps its last list.
- Server utility asks no longer see AGENTS.md files from the server's working directory (the server has no source checkout).
- Test-registered Pi providers must be registered with both the server's and the in-process node's model runtimes (`__tests__/helpers/pi-providers.ts`).
- Details: [node-contract.md](../dev/node-contract.md) *Packages and import boundaries*, *Skills*.
