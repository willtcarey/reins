# Dev Reload

Under `bun run dev` both processes pick up code changes without a manual restart:

- **Server** (`REINS_DEV=1`): hot-reloads its handler code, including the shared workspace packages it
  imports (`@reins/node-protocol`, `@reins/pi-sql-storage`), without restarting the process. The
  server imports nothing from `@reins/node`.
- **Node** (`REINS_NODE_DEV_RELOAD=1`, set by the dev supervisor): restarts its process on a change to
  node code or to the shared packages it imports, but only once it is idle, so a run is never
  interrupted (see *Node reload* below).

Agent sessions stay alive mid-turn either way.

## Server hot reload

### Architecture

```
index.ts → server-process.ts (process owner, never reloads)
┌──────────────────────────────────────────┐
│ processState: ProcessState = {           │
│   clients: Set<WsClient>                 │
│   frontendDir                            │
│ }                                        │
│ db = openDb()   (migrations + outbox     │
│                  recovery, once)         │
│ state: ServerState  (processState +      │
│                      installed hub)      │
│                                          │
│ let routes, ws  ─────────────────────────┼──┐   .dev-build/<pid>/
│ let uninstallHandler()                   │  │   ┌──────────────────────┐
│                                          │  ├──► server.js (bundled)  │
│ Bun.serve (HTTP + browser WS)            │  │   │  routes = handler.ts │
│   fetch → routes.handleFetch(state, …)   │  │   │  ws = ws.ts, setDb   │
│   ws.* → ws.handleWs*(state, …)          │  │   └──────────────────────┘
│ node socket listener                     │  │          ▲
│   → routes.acceptNodeConnection(state, …)│  │          │ buildDevBundle()
│                                          │  │          │
│ watch(src/, shared pkgs) ── on change ───┼──┘          │
│   → buildDevBundle(server.ts) ───────────┼─────────────┘
│   → import(server.js?t=…); setDb(db)     │
│   → installed = routes.install(procState)│  (new node hub → state.nodes)
│   → uninstallHandler?.()                 │  (old hub closes; node redials)
│   → uninstallHandler = installed.uninstall│
└──────────────────────────────────────────┘
```

### How it works

- **`server-process.ts`** (loaded by `index.ts`) owns long-lived process state: WS clients, the
  frontend dir, the Bun server, the database handle and the local node socket listener. It delegates
  request handling through mutable `routes` and `ws` references.
- **`server.ts`** is the handler bundle's entry: it exports `routes` (`handler.ts`), `ws` (`ws.ts`) and
  `setDb`, which injects the process's database into the bundle's scope so a reload never opens a second
  connection or re-runs startup recovery.
- **`handler.ts`** handles HTTP (router, WebSocket upgrades, static files), accepts node connections
  (`acceptNodeConnection` → `state.nodes.accept`) and exposes `install(processState)`, which creates and
  starts this install's node hub and returns `{state, uninstall}`.
- **`ws.ts`** handles the browser WebSocket lifecycle and dispatches `prompt`, `steer`, `abort`.
- **`state.ts`** defines the shared types (`ProcessState`, `ServerState`, `NodeHub`). The server holds
  no session runtimes: sessions run in the node process.
- On a `.ts` change in `src/`, `packages/node-protocol/src/` or `packages/pi-sql-storage/src/` (tests
  and `__fixtures__`-style directories ignored), `server-process.ts` rebuilds the handler bundle
  (`dev-build.ts`): `server.ts` with every transitive `src/` import **and every workspace package source
  it reaches (`@reins/*`: `@reins/node-protocol`, `@reins/pi-sql-storage`)** goes into `.dev-build/`.
  Third-party packages and builtins stay external, imported by bare specifier, so they load once per
  process and keep one module instance across reloads (Pi's provider registry, for example); a shared
  package's dependency must therefore also resolve from `packages/backend`. Bundled
  sources keep their own `import.meta.url`/`dirname`/`path` (rewritten to the source file's), so code
  that finds files relative to itself works as unbundled. The bundle is then imported with a
  cache-busting query string (`?t=<timestamp>`), swapping the handler references.
- After each import, `server-process.ts` calls `routes.install(processState)`, installs the new
  handler (its hub becomes `state.nodes`), then calls the previous handler's `uninstall`, which closes
  the old hub.
- Because the build bundles the full transitive dependency tree under `src/` and the workspace
  packages, a change to *any* of those source files (e.g. `sessions.ts`, `routes/projects.ts`,
  `packages/node-protocol/src/schema.ts`) takes effect on reload — not just `handler.ts` or `ws.ts`.
- The Bun server, WebSocket connections and the local node socket listener remain
  alive. The node runs in its own process: the old handler's cleanup closes its node
  connection, the node redials and reaches the new handler, and its runs continue
  untouched (see [node-contract.md](node-contract.md) *Transport*, "Server handler hot reload"). The *server's* copy of
  the shared packages reloads with the handlers; the node process reloads its own (below).
- Each dev server bundles into its own `.dev-build/<pid>/` (removed on exit; stale
  ones are removed at the next dev start), so two dev servers from one checkout never
  import each other's half-written bundles.
- `kill -USR2 <server pid>` runs the same reload without a source change.

## Node reload

The node process cannot swap code in place (its runs hold Pi runtimes), so it restarts instead, and
only when that interrupts nothing (`packages/node/src/dev-reload.ts`, wired in `main.ts`):

- With `REINS_NODE_DEV_RELOAD=1` (only `supervisor.ts dev` sets it; `start` and a standalone
  `bun run start:node` never reload), the node watches `packages/node/src` and the shared packages it
  imports, `packages/node-protocol/src` and `packages/pi-sql-storage/src` (`reloadSourceDirs`; ignoring
  `*.test.ts`, `__*__/`, `dist/`). `kill -USR2 <node pid>` requests the same reload without a source change.
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
  `@reins/node-protocol` (the socket listener's framing, the default socket path) also stay as loaded until a restart.
- Schema migrations run when the process first opens the database, not on handler hot reload. Restart the backend after adding a migration; hot reload alone will not update an existing connection's schema.
- If the `Bun.build()` step fails (e.g. syntax error), the reload fails
  gracefully and the previous handlers remain active (error is logged to
  console).
