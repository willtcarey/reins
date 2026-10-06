# Dev Docs

| Doc | Package | Description |
|---|---|---|
| [hot-reload.md](hot-reload.md) | backend | Dev reload: product handler/service swaps preserve node links; process-owned infrastructure/protocol and node code require restart |
| [node-transport.md](node-transport.md) | backend/node | The server–node link, explained with diagrams: layers from socket bytes to product calls, framing and socket permissions, JSON-RPC, `node.hello` and epochs, heartbeat, frame caps, wire errors, method tables and naming, streams, reconnecting, hot reload, test links and failure handling. Read before node-contract.md |
| [node-contract.md](node-contract.md) | backend/node | What the server and node say over the link: package layout and import boundaries, processes, session commands, checkout operations, command outbox, session storage, credentials, attachments, crash recovery, idempotency, fencing, moves |
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
| [meridian.md](meridian.md) | local dev | Local Claude endpoint: tmux startup, diagnostics, and OAuth renewal |
| [workflow.md](workflow.md) | all | Development workflow: RGR, testing reference, pre/post-implementation checklist |
| [error-handling.md](error-handling.md) | all | Error handling posture: when to throw, bubble, catch, or surface failures |
| [testing-structure.md](testing-structure.md) | all | Test organization convention: mirror source/app folder structure |
| [code-style.md](code-style.md) | all | Repo-wide code and documentation style conventions |
| [pwa.md](pwa.md) | frontend | PWA manifest, service worker, icons |
| [reactive-controllers.md](reactive-controllers.md) | frontend | Using Lit Reactive Controllers to extract testable logic from components |
| [tool-renderers.md](tool-renderers.md) | frontend | Tool renderer registry, per-tool rendering tiers, adding new renderers |
| [lit-conventions.md](lit-conventions.md) | frontend | Lit gotchas: cross-component template `this` binding, conventions |
| [session-message-persistence.md](session-message-persistence.md) | backend/node | Canonical AgentHarness entries, archive/active projections, provider normalization, and lifecycle ordering |

