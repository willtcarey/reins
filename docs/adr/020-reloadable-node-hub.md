# ADR-020: Reloadable Node Hub

- **Status:** Accepted
- **Date:** 2026-10-06
- **Supersedes:** the link-ownership decision of [ADR-016](016-process-owned-node-hub.md)
- **Amended by:** [ADR-021](021-explicit-node-reload.md) (the node reloads on an explicit request; lost runs are resumed)

## Context

[ADR-016](016-process-owned-node-hub.md) made the node hub, its connections, the command dispatcher and submission recipients process-owned, so a dev handler reload would not drop the node link. A drop then had real costs: a commit or lifecycle report whose reply was lost failed its run or was lost. Keeping the link alive took machinery that existed only for reloads: `restartRequired` rules making `node-link/` and a list of other modules restart-only, a dev-bundle plugin rewriting their imports to file URLs, a test keeping their static imports inside the set, a per-call lookup of the current product services (`NodeHubServices`) and per-request handler resolution in the server transport, and `DeliveryDeferred` moved into `@reins/node-protocol` for error identity between the process-owned dispatcher and reloaded product code. Edits under `node-link/` needed a server restart.

Since then commits and lifecycle reports became retry-safe: one whose reply was lost is resent on the next connection and the server recognises the repeat (`commitId`, `reportId`; [ADR-010](010-state-derived-idempotency.md)). Outbox commands already replayed safely. A dropped link now costs a reconnect, and remote links will drop on their own, so this path has to work anyway.

## Decision

A handler reload replaces the node side with everything else. Each handler load builds its own state (`createServerState`: the process's browser clients and a new hub) and node socket listener; the reload closes the previous load's hub and listener, so the node's connection closes and the node redials the new one. Work in flight recovers through the ordinary link-loss paths: outbox deliveries requeue and replay, unanswered commits and reports are resent and recognised, the node's hello keeps its running sessions from being settled as interrupted.

Delete what existed only to keep links across reloads:

- `restartRequired` and the process-owned module list; the dev bundle includes every local source, the hub included, and no longer rewrites imports. The watcher warns only for the process owner's own code.
- The per-call services lookup and the port behind it (`NodeHubServices`): the hub calls product code directly, and a connection resolves its node's handlers once, at hello.
- `DeliveryDeferred` returns to the backend (`nodes/node-command-dispatcher.ts`).
- Submission failure recipients move off the hub onto the browser client (`WsClient.submissions`), which outlives a reload.
- The `node-link/` folder, split from `nodes/` by process ownership, is folded into `nodes/`: the link, the outbox and the handlers serving node calls are one module group again.

The handler module (`server.ts`) exposes `start` and `stop`; the process owner keeps only the HTTP server and the browser sockets, and awaits the running load's `stop` before starting the next. Each load owns its database: it opens it (migrations, then outbox recovery) on start and closes it on stop, once its deliveries settled, so recovery never runs against another dispatcher's in-flight delivery.

Kept, for reasons of their own: `@reins/node-protocol` stays external to dev bundles, because the node does not hot reload and a protocol edit must not apply on the server alone; `script.execute` is not resent (it has side effects), so a drop during it fails that tool call with "may have run".

## Consequences

- Every server source except the process owner hot reloads, the hub, transport, database startup and migrations included.
- A reload has a brief gap (the old load settling, the new one opening its database) in which HTTP answers 503.
- A reload costs a reconnect (about 100 ms) and the failure of whatever cannot be resent: request-now calls and streams fail with `unavailable`, a script in flight fails as "may have run", and a `storage.read` in flight fails its run (reads are not resent).
- Two dispatchers can briefly overlap during a reload (the previous one finishing a delivery); the outbox's atomic claim keeps a session to one command in flight.
- Reload is now exercised by the same paths as a real drop, so dev use keeps them tested.
- See [hot-reload.md](../dev/hot-reload.md).
