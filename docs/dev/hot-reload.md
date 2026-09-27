# Backend Hot Reload

In dev mode (`REINS_DEV=1`), the backend hot-reloads handler code without
restarting the process. Agent sessions stay alive mid-turn.

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
- On a `.ts` change in `src/`, `index.ts` runs **`Bun.build()`** with
  `routes.ts` and `ws.ts` as entrypoints. This bundles them (along with all
  transitive `src/` imports) into `.dev-build/`, keeping `node_modules`
  external. The bundled files are then imported with a cache-busting query
  string (`?t=<timestamp>`), swapping the handler references.
- After each import, `index.ts` calls `routes.install(state)` and stores the
  returned cleanup function in stable process state. On the next reload it
  installs the new hooks, then calls the previous cleanup.
- Because the build bundles the full transitive dependency tree under `src/`,
  a change to *any* source file (e.g. `sessions.ts`, `router.ts`,
  `routes/projects.ts`) triggers a reload — not just `routes.ts` or `ws.ts`.
- The Bun server, WebSocket connections and the local node socket listener remain
  alive. The node runs in its own process: the old handler's cleanup closes its node
  connection, the node redials and reaches the new handler, and its runs continue
  untouched (see node-contract.md *Transport*, "Server handler hot reload"). Node package
  code is external to the server dev bundle and is **restart-required**, not
  hot-reloaded: restart the node process (under `bun run dev`, kill it and the
  supervisor restarts it).
- Each dev server bundles into its own `.dev-build/<pid>/` (removed on exit; stale
  ones are removed at the next dev start), so two dev servers from one checkout never
  import each other's half-written bundles.
- `kill -USR2 <server pid>` runs the same reload without a source change.

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

- Changes to `index.ts`, `state.ts`, node package code, node storage schema or process-owner configuration require a manual restart since
  they own the process lifecycle and type definitions.
- Schema migrations run when the process first opens the database, not on handler hot reload. Restart the backend after adding a migration; hot reload alone will not update an existing connection's schema.
- If the `Bun.build()` step fails (e.g. syntax error), the reload fails
  gracefully and the previous handlers remain active (error is logged to
  console).
