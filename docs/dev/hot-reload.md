# Dev Reload

Under `bun run dev` only the **server** picks up code changes without a restart:

- **Server** (`REINS_DEV=1`): hot-reloads its handler code, including the shared workspace packages it
  imports (`@reins/node-protocol`, `@reins/pi-sql-storage`, `@reins/telemetry`), without restarting the process. The
  server imports nothing from `@reins/node`. Agent sessions stay alive mid-turn.
- **Node**: does **not** hot reload (see *Node changes* below). It runs the code it started with until
  it is restarted.

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
- On a `.ts` change in `src/`, `packages/node-protocol/src/`, `packages/pi-sql-storage/src/` or `packages/telemetry/src/` (tests
  and `__fixtures__`-style directories ignored), `server-process.ts` rebuilds the handler bundle
  (`dev-build.ts`): `server.ts` with every transitive `src/` import **and every workspace package source
  it reaches (`@reins/*`: `@reins/node-protocol`, `@reins/pi-sql-storage`, `@reins/telemetry`)** goes into `.dev-build/`.
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
  the shared packages reloads with the handlers; the node keeps its own until it is restarted (below).
- Each dev server bundles into its own `.dev-build/<pid>/` (removed on exit; stale
  ones are removed at the next dev start), so two dev servers from one checkout never
  import each other's half-written bundles.
- `kill -USR2 <server pid>` runs the same reload without a source change.

## Node changes

The node process has no dev reload: nothing watches `packages/node/src` or the node's copy of the shared
packages, in `dev` or `start`. A change to node code (or to `@reins/node-protocol` /
`@reins/pi-sql-storage` as the node uses them) takes effect only when the node is restarted:

- restart `bun run dev` (the supervisor stops the node with SIGTERM, which aborts and durably settles
  its active runs), or
- run the server and node separately (`bun packages/backend/dev.ts` and `bun run start:node`) and
  restart just the node. It reconnects and replays its outbox; work the server queued meanwhile is
  delivered over the new connection.

Restarting interrupts the node's active runs (they are aborted, not lost), so choose when to do it.
A shared-package change hot-reloads the server immediately while the running node keeps the old copy,
so keep protocol changes wire-compatible (additive) with a node that has not restarted yet.

A possible future approach is testing node changes on a second, separately started dev node rather than
restarting the main one.

## Usage

```sh
# Full dev stack (server with hot reload + node + supervised frontend JS/CSS watchers)
bun run dev

# Server-only dev mode (hot reload enabled); run the node separately and restart it after node changes
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
