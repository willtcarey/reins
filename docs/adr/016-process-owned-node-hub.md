# ADR-016: Process-Owned Node Links and Reloadable Product Handlers

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

Every HTTP-handler reload created a new node hub/dispatcher and closed the old node connections. Route edits therefore caused reconnects, unknown admission outcomes and overlapping dispatcher lifetimes. Keeping Pi on execution nodes is intentional: it distributes session resources and keeps agent execution with its checkout. Moving Pi into separate server-side workers would retain much of the same coordination and add a tools-only node link.

## Decision

Keep Pi on nodes. The server process owns the node hub, connections, epochs, command dispatcher and submission recipients for its lifetime. Handler reload replaces product services, not execution links.

Each node call captures the current product handlers when it starts. In-flight calls finish against their captured handlers; later calls use the replacement. Source resolution and command delivery also use current product services. The database and interrupted-dispatch recovery remain process-owned.

Keep `@reins/node-protocol` and the explicitly listed process-owned modules external to dev bundles, with one process-lifetime identity. Local process-owned imports use original file URLs, avoiding both `.dev-build` relative-resolution failures and edited infrastructure being pulled into a later product reload. Protocol/infrastructure changes require a restart, with a watcher warning rather than a partial reload. A protocol change requires coordinated server/node restart.

## Consequences

- HTTP/product edits no longer disconnect nodes or abort calls merely to install handlers.
- Real disconnect handling, fencing, admission idempotency, durable outbox claims and startup recovery remain necessary.
- Process-owned implementation changes trade immediate hot reload for explicit, predictable restart.
- Child replies are projected where canonical storage lives. Settlements carry Pi's committed `run_end.tipId`; a delayed report cannot select a newer branch. This changes the wire contract to version 4.
- The dormant backend Claude SDK runtime is removed, including its scripts/dependencies and import exceptions. Future runtime support belongs on the node and must satisfy the current storage/admission/event contracts.
