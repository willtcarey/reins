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
│   explicitModel                  │
│ }                                │
│                                  │
│ let routes: RoutesModule  ───────┼──┐
│ let ws: WsModule          ───────┼──┤
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
└──────────────────────────────────┘

routes.ts ──► routes/index.ts ──► routes/*.ts
  handleFetch(state, req, server)

ws.ts
  handleWsOpen(state, ws)
  handleWsMessage(state, ws, message)
  handleWsClose(state, ws)

state.ts (types only)
  ServerState, ManagedSession, WsClient
```

## How it works

- **`index.ts`** owns long-lived state (sessions map, clients set, Bun server).
  It delegates all request handling through mutable `routes` and `ws`
  references.
- **`routes.ts`** is the HTTP entry point — it handles WebSocket upgrades,
  delegates API routes via the router (`routes/index.ts` → per-resource route
  files), and serves static frontend files.
- **`ws.ts`** handles the WebSocket lifecycle (`open`, `message`, `close`) and
  dispatches commands (`prompt`, `steer`, `abort`).
- **`state.ts`** defines the shared types (`ServerState`, `ManagedSession`,
  `WsClient`).
- On a `.ts` change in `src/`, `index.ts` runs **`Bun.build()`** with
  `routes.ts` and `ws.ts` as entrypoints. This bundles them (along with all
  transitive `src/` imports) into `.dev-build/`, keeping `node_modules`
  external. The bundled files are then imported with a cache-busting query
  string (`?t=<timestamp>`), swapping the handler references.
- Because the build bundles the full transitive dependency tree under `src/`,
  a change to *any* source file (e.g. `sessions.ts`, `router.ts`,
  `routes/projects.ts`) triggers a reload — not just `routes.ts` or `ws.ts`.
- The Bun server, WebSocket connections, and agent sessions are never torn
  down — only the handler *functions* are swapped.

## Usage

```sh
# Dev mode (hot reload enabled)
bun packages/backend/dev.ts

# Production (no watcher, single static import)
bun packages/backend/src/index.ts
```

## Caveats

- Changes to `index.ts` or `state.ts` still require a manual restart since
  they own the process lifecycle and type definitions.
- If the `Bun.build()` step fails (e.g. syntax error), the reload fails
  gracefully and the previous handlers remain active (error is logged to
  console).
