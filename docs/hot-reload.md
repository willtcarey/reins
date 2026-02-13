# Backend Hot Reload

In dev mode (`REINS_DEV=1`), the backend hot-reloads handler code without
restarting the process. Agent sessions stay alive mid-turn.

## Architecture

```
index.ts (stable, never reloads)          handlers.ts (hot-reloaded)
┌─────────────────────────────┐           ┌──────────────────────────┐
│ state = {                   │           │ handleFetch(state, ...)  │
│   sessions: Map  ◄──────────┼── alive ──│ handleWsCommand(state,..)│
│   clients: Set              │           │ openSession(state, ...)  │
│   defaultSessionId          │           │ getGitDiff(...)          │
│ }                           │           │ buildInitPayload(...)    │
│                             │  import() │                          │
│ let handlers = ─────────────┼───────────►                          │
│                             │  (swap)   │                          │
│ Bun.serve({                 │           └──────────────────────────┘
│   fetch → handlers.X()     │
│   ws    → handlers.Y()     │           state.ts (types only)
│ })                          │           ┌──────────────────────────┐
│                             │           │ ServerState, WsClient,   │
│ fs.watch src/ → re-import ──┼───────┐   │ ManagedSession           │
└─────────────────────────────┘       │   └──────────────────────────┘
                                      │
                              on .ts change:
                              handlers = import("handlers.ts?t=...")
```

## How it works

- **`index.ts`** owns long-lived state (sessions map, clients set, Bun server).
  It delegates all request handling through a mutable `handlers` reference.
- **`handlers.ts`** contains all routing, command handling, and session creation
  logic. Functions receive a `ServerState` object so they can access sessions
  and clients without owning them.
- **`state.ts`** defines the shared types (`ServerState`, `ManagedSession`,
  `WsClient`).
- When a `.ts` file in `src/` changes, `index.ts` re-imports `handlers.ts`
  with a cache-busting query string (`?t=<timestamp>`), creating a fresh
  module instance. The old module is garbage collected.
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
- If `handlers.ts` has a syntax error, the reload fails gracefully and the
  previous handlers remain active (error is logged to console).
