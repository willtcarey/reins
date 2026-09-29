# Dev Docs

| Doc | Package | Description |
|---|---|---|
| [hot-reload.md](hot-reload.md) | backend | Dev reload: server handler hot reload (incl. the shared `@reins/node-protocol`/`@reins/telemetry` code); the node does not hot reload |
| [node-contract.md](node-contract.md) | backend/node | Server–node contract: package layout and import boundaries, processes, transport, wire methods, command outbox, session storage over the link, crash recovery, idempotency, fencing, moves, credentials |
| [node-runtime.md](node-runtime.md) | node | The node's Pi session runtime: assembly, operations, events and their ordering, lifecycle reports, message shapes |
| [backend-architecture.md](backend-architecture.md) | backend | Backend layering: routes, tools, models, stores, utilities |
| [router.md](router.md) | backend | Router API, adding routes, error handling |
| [logging.md](logging.md) | backend | Logger levels, test behavior, and runtime verbosity configuration |
| [client-telemetry.md](client-telemetry.md) | all | Development-only browser and server diagnostics (`@reins/telemetry`), bounded retention, inspection, and instrumentation |
| [frontend-architecture.md](frontend-architecture.md) | frontend | Store layer, WS event flow, component structure, how views consume state |
| [extension-architecture.md](extension-architecture.md) | all | Plugin-first capability contracts, built-in adapters, and interface maturity |
| [review-virtualization.md](review-virtualization.md) | frontend | Ownership boundaries and invariants for the Reins-owned virtual review surface |
| [ui-design.md](ui-design.md) | frontend | CSS architecture, z-index layers, color palette, syntax highlighting, responsive patterns |
| [tauri.md](tauri.md) | tauri | Optional Tauri desktop wrapper: setup, backend URL behavior, packaging |
| [docker.md](docker.md) | all | Building and running REINS in a Docker container |
| [workflow.md](workflow.md) | all | Development workflow: RGR, testing reference, pre/post-implementation checklist |
| [error-handling.md](error-handling.md) | all | Error handling posture: when to throw, bubble, catch, or surface failures |
| [testing-structure.md](testing-structure.md) | all | Test organization convention: mirror source/app folder structure |
| [code-style.md](code-style.md) | all | Repo-wide code and documentation style conventions |
| [pwa.md](pwa.md) | frontend | PWA manifest, service worker, icons |
| [reactive-controllers.md](reactive-controllers.md) | frontend | Using Lit Reactive Controllers to extract testable logic from components |
| [tool-renderers.md](tool-renderers.md) | frontend | Tool renderer registry, per-tool rendering tiers, adding new renderers |
| [lit-conventions.md](lit-conventions.md) | frontend | Lit gotchas: cross-component template `this` binding, conventions |
| [session-message-persistence.md](session-message-persistence.md) | backend/node | Canonical AgentHarness entries, archive/active projections, provider normalization, and lifecycle ordering |

