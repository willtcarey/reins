# Dev Docs

| Doc | Package | Description |
|---|---|---|
| [hot-reload.md](hot-reload.md) | backend | How backend hot-reload works in dev mode |
| [backend-architecture.md](backend-architecture.md) | backend | Backend layering: routes, tools, models, stores, utilities |
| [router.md](router.md) | backend | Router API, adding routes, error handling |
| [logging.md](logging.md) | backend | Logger levels, test behavior, and runtime verbosity configuration |
| [frontend-architecture.md](frontend-architecture.md) | frontend | Store layer, WS event flow, component structure, how views consume state |
| [ui-design.md](ui-design.md) | frontend | CSS architecture, z-index layers, color palette, syntax highlighting, responsive patterns |
| [macos.md](macos.md) | macos | Native Mac app shell: setup, dev workflow, building |
| [tauri.md](tauri.md) | tauri | Tauri desktop wrapper: setup, backend URL behavior, packaging |
| [docker.md](docker.md) | all | Building and running REINS in a Docker container |
| [workflow.md](workflow.md) | all | Development workflow: RGR, testing reference, pre/post-implementation checklist |
| [error-handling.md](error-handling.md) | all | Error handling posture: when to throw, bubble, catch, or surface failures |
| [testing-structure.md](testing-structure.md) | all | Test organization convention: mirror source/app folder structure |
| [code-style.md](code-style.md) | all | Repo-wide code and documentation style conventions |
| [pwa.md](pwa.md) | frontend | PWA manifest, service worker, icons |
| [reactive-controllers.md](reactive-controllers.md) | frontend | Using Lit Reactive Controllers to extract testable logic from components |
| [tool-renderers.md](tool-renderers.md) | frontend | Tool renderer registry, per-tool rendering tiers, adding new renderers |
| [lit-conventions.md](lit-conventions.md) | frontend | Lit gotchas: cross-component template `this` binding, conventions |
| [runtime-event-compatibility.md](runtime-event-compatibility.md) | backend | Runtime adapter event compatibility contract for persistence, WS broadcast, and normalization |
| [pi-runtime-event-order.md](pi-runtime-event-order.md) | backend | Pi lifecycle event ordering notes, especially compaction before `agent_start` |
| [runtime-adapter-contract.md](runtime-adapter-contract.md) | backend | Minimum viable runtime adapter contract: adapter methods, runtime methods, events, messages, tools, and resume expectations |

