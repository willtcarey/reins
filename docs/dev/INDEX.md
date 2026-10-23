# Dev Docs

| Doc | Package | Description |
|---|---|---|
| [hot-reload.md](hot-reload.md) | backend | Dev reload: what the process owns and what an app owns (lifetimes and who may keep what), the process-owned sources and their import rule; the app (session runtime code and node hub included) reloads; running sessions are kept and keep their code until idle; the node redials and tool calls ride through; the process-owned code (`ServerProcess`, open sessions and database included), the protocol and node code require a restart or an explicit node reload |
| [node-transport.md](node-transport.md) | backend/node | The server–node link, explained with diagrams: layers from socket bytes to product calls, framing and socket permissions, JSON-RPC, `node.hello` and negotiation, heartbeat, frame caps, wire errors, method tables and naming, streams, reconnecting, hot reload, test links and failure handling. Read before node-contract.md |
| [node-contract.md](node-contract.md) | backend/node | What a node is (a tool and file host) and what the server owns: package layout and import boundaries, processes, pausing and reloading a node, pairing and authentication, checkout operations, files (`fs.*`) and shell commands (`pi.*`), the node hub and sources, moves, what happens when a node goes away |
| [node-bundle.md](node-bundle.md) | backend/cli/node | The node bundle (`reins.js`): building it (`buildNodeBundle`, Pi's execution environment only, guards, a test build, determinism, build ID), what its entry does before running the CLI (the docs it carries), serving it (`/nodes/install`, `/nodes/manifest`, the bundle), the install script, the node home's layout, `reins node setup` and the launcher, self-updates, and its tests |
| [session-runtime.md](session-runtime.md) | backend | Sessions on the server: the process-owned runtime map and idle eviction, how a runtime reaches the current app, opening and assembly, the environment (server plus checkout), operations and pause points, submission and ordering, events and their ordering, lifecycle and child reports, recovery and SIGTERM |
| [backend-architecture.md](backend-architecture.md) | backend | Backend layering: routes, tools, models, stores, utilities |
| [router.md](router.md) | backend | Router API, adding routes, error handling |
| [logging.md](logging.md) | backend | Logger levels, test behavior, and runtime verbosity configuration |
| [client-telemetry.md](client-telemetry.md) | all | Development-only browser and server diagnostics (`@reins/telemetry`), bounded retention, inspection, and instrumentation |
| [frontend-architecture.md](frontend-architecture.md) | frontend | Store layer, WS event flow, component structure, how views consume state |
| [extension-architecture.md](extension-architecture.md) | all | Plugin-first capability contracts, built-in adapters, and interface maturity |
| [reins-sdk.md](reins-sdk.md) | frontend | The Reins SDK: the API app-shell builds over `AppStore` and gives to the built-ins' register functions (files, `workspace.open`, view and message-decorator registration), the contract and the registries, the Changes-tab exception, and what is not built yet |
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
| [session-message-persistence.md](session-message-persistence.md) | backend | Canonical AgentHarness entries, archive/active projections, provider normalization, and lifecycle ordering |

