# Dev Reload

Under `bun run dev` both processes pick up code changes without a manual restart:

- **Server** (`REINS_DEV=1`): hot-reloads its handler code, including the `@reins/node` code it
  imports (protocol, contract, storage adapters, …), without restarting the process.
- **Node** (`REINS_NODE_DEV_RELOAD=1`, set by the dev supervisor): restarts its process on a node code
  change, but only once it is idle, so a run is never interrupted (see *Node reload* below).

Agent sessions stay alive mid-turn either way.

## Server hot reload

## Architecture

```
index.ts (stable, never reloads)
┌──────────────────────────────────┐
│ state: ServerState = {           │
│   sessions: Map                  │
│   clients: Set                   │
│   frontendDir                    │
│ }                                │
│                                  │
│ let routes: RoutesModule  ───────┼──┐
│ let ws: WsModule          ───────┼──┤
│ let uninstallRuntimeHooks() ─────┼──┤
│                                  │  │
│ Bun.serve({                      │  │  .dev-build/
│   fetch → routes.handleFetch()   │  │  ┌──────────────────────┐
│   ws.open → ws.handleWsOpen()    │  ├──► routes.js (bundled)  │
│   ws.message → ws.handleWsMsg()  │  │  │ ws.js     (bundled)  │
│   ws.close → ws.handleWsClose()  │  │  └──────────────────────┘
│ })                                │  │        ▲
│                                  │  │        │ Bun.build()
│ watch(src/) ─── on .ts change ───┼──┘        │
│   → Bun.build([routes.ts, ws.ts])────────────┘
│   → import(.dev-build/*.js?t=…)  │
│   → next = routes.install(state) │
│   → uninstallRuntimeHooks?.()    │
│   → uninstallRuntimeHooks = next │
└──────────────────────────────────┘

routes.ts ──► routes/index.ts ──► routes/*.ts
  handleFetch(state, req, server)

ws.ts
  handleWsOpen(state, ws)
  handleWsMessage(state, ws, message)
  handleWsClose(state, ws)

state.ts (types only)
  ServerState, WsClient
```

## How it works

- **`index.ts`** owns long-lived state (clients set, frontend dir,
  Bun server). It delegates all request handling through mutable `routes` and
  `ws` references.
- **`routes.ts`** is the HTTP entry point — it handles WebSocket upgrades,
  delegates API routes via the router (`routes/index.ts` → per-resource route
  files), serves static frontend files, and exposes an `install(state)` hook
  that returns a cleanup function for hot-reloadable runtime wiring.
- **`ws.ts`** handles the WebSocket lifecycle (`open`, `message`, `close`) and
  dispatches commands (`prompt`, `steer`, `abort`).
- **`state.ts`** defines the shared types (`ServerState`, `WsClient`). The server
  holds no session runtimes: sessions run in the node process.
- On a `.ts` change in `src/` or in `packages/node/src/` (tests and `__fixtures__`-style directories
  ignored), `server-process.ts` rebuilds the handler bundle (`dev-build.ts`): `server.ts` with every
  transitive `src/` import **and every workspace package source (`@reins/*`, i.e. `@reins/node`)** goes
  into `.dev-build/`. Third-party packages and builtins stay external, imported by bare specifier, so
  they load once per process and keep one module instance across reloads (Pi's provider registry, for
  example); a node-package dependency must therefore also resolve from `packages/backend`. Bundled
  sources keep their own `import.meta.url`/`dirname`/`path` (rewritten to the source file's), so code
  that finds files relative to itself works as unbundled. The bundle is then imported with a
  cache-busting query string (`?t=<timestamp>`), swapping the handler references.
- After each import, `index.ts` calls `routes.install(state)` and stores the
  returned cleanup function in stable process state. On the next reload it
  installs the new hooks, then calls the previous cleanup.
- Because the build bundles the full transitive dependency tree under `src/` and the workspace
  packages, a change to *any* of those source files (e.g. `sessions.ts`, `routes/projects.ts`,
  `packages/node/src/protocol/schema.ts`) takes effect on reload — not just `routes.ts` or `ws.ts`.
- The Bun server, WebSocket connections and the local node socket listener remain
  alive. The node runs in its own process: the old handler's cleanup closes its node
  connection, the node redials and reaches the new handler, and its runs continue
  untouched (see node-contract.md *Transport*, "Server handler hot reload"). The *server's* copy of
  node package code reloads with the handlers; the node process reloads its own (below).
- Each dev server bundles into its own `.dev-build/<pid>/` (removed on exit; stale
  ones are removed at the next dev start), so two dev servers from one checkout never
  import each other's half-written bundles.
- `kill -USR2 <server pid>` runs the same reload without a source change.

## Node reload

The node process cannot swap code in place (its runs hold Pi runtimes), so it restarts instead, and
only when that interrupts nothing (`packages/node/src/dev-reload.ts`, wired in `main.ts`):

- With `REINS_NODE_DEV_RELOAD=1` (only `supervisor.ts dev` sets it; `start` and a standalone
  `bun run start:node` never reload), the node watches `packages/node/src` (ignoring `*.test.ts`,
  `__*__/`, `dist/`). `kill -USR2 <node pid>` requests the same reload without a source change.
- Changes within 200 ms are one reload. When one is due, the node checks every 250 ms until it is idle:
  no active run (admitting, starting or running), no command being handled (from receipt to reply,
  attachment downloads included) and no runtime opening or session work (provision, hydrate) in
  progress. Meanwhile it keeps serving commands and logs `code changed (…); waiting for N active runs
  before reloading`.
- When idle it logs `node reloading after code change (…)`, stops exactly as on SIGTERM (closes its
  connection, `Node.shutdown()`, closes its database; nothing is active, so nothing is aborted) and
  exits with code **75** (`NODE_RELOAD_EXIT_CODE`).
- The supervisor restarts a node that exits 75 immediately, however often (`node restarting now to
  reload`); any other exit keeps the crash backoff. The new node reconnects and replays its outbox;
  commands the server submitted meanwhile waited in the server's outbox and are delivered once over the
  new connection.
- A run that never ends postpones the reload; stop it (or restart `bun run dev`) if needed.

## Usage

```sh
# Full dev stack (server with hot reload + node + supervised frontend JS/CSS watchers)
bun run dev

# Server-only dev mode (hot reload enabled); run the node separately
bun packages/backend/dev.ts
bun run start:node

# Production server only (no watcher, single static import)
bun packages/backend/src/index.ts
```

## Caveats

- Changes to `index.ts`, `server-process.ts`, `dev-build.ts`, `state.ts` or process-owner configuration require a manual server
  restart since they own the process lifecycle and type definitions. The server process's own (stable) imports of
  `@reins/node` (the socket listener's framing, the default socket path) also stay as loaded until a restart.
- Schema migrations run when the process first opens the database, not on handler hot reload. Restart the backend after adding a migration; hot reload alone will not update an existing connection's schema.
- If the `Bun.build()` step fails (e.g. syntax error), the reload fails
  gracefully and the previous handlers remain active (error is logged to
  console).
