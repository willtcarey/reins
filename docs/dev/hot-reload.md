# Dev Reload

Under `bun run dev`, HTTP/browser handlers and product services hot reload. **Pi sessions stay on the node, and server node connections and dispatch stay alive across a handler reload.** Process-owned code and node code require a restart.

## Ownership

```text
server-process.ts (never reloads)
  database: openDb once, setDb in every handler bundle
  ServerState: clients, frontendDir, nodes
  node hub: connections, epochs, dispatcher, submission recipients
  socket listener → state.nodes.accept
  mutable routes / ws / node product services
    ↑ buildDevBundle(server.ts), import, swap after successful load

node process (never hot reloads)
  Pi runtimes, execution environments, in-memory caches
```

`server.ts` exports HTTP handlers, browser WS handlers, `setDb` and `nodeServerServices`. Each load injects the process database and constructs the new product services before swapping the references. There is no handler install/uninstall and no connection handoff. The hub's port (`NodeHubServices` in `node-link/node-hub.ts`, built by `nodeServerServices` in `nodes/node-services.ts`) is four calls: `handlers(nodeId)` (a node's fenced node→server handlers: storage, lifecycle reports, events, attachments, tool calls, credentials), `recover` (crash recovery at hello), `route(sessionId)` (a session's node and how to send it a command) and `delivered` (settled-command notifications). The process-owned hub resolves the port for each call, not once per connection. An already-started call finishes using its captured handlers; a subsequent call uses the new ones.

Process-owned code reaches product code only through those services: its static imports stay process-owned (`restartRequired` in `dev-build.ts`; type-only imports aside; `migrations.ts` runs once at startup), or it would keep a process-lifetime copy of reloadable code that later reloads never replace. `dev-build.test.ts` enforces this. What process-owned code needs from product code is either a service call or moved into a process-owned module (e.g. `NodeLink` and the command timeouts in `node-link/node-hub.ts`, the admission proof `storedInput` in `pi-session-store.ts`).

The process opens the database, recovers interrupted command dispatches, starts the hub and listens on the node socket once. HTTP reloads do none of those things. Submission failure recipients also survive reloads. The hub closes only on process shutdown or an actual node disconnect/replacement.

## What reloads

- Product code under `packages/backend/src`, except process-owned code (`restartRequired` in `dev-build.ts`): everything under `node-link/` plus the bootstrap, database and logger modules and `pi-session-store.ts`. Product code the hub calls lives in `nodes/` and `sessions/` and reloads.
- `@reins/telemetry` source used by product handlers.
- The Reins system prompt (`sessions/system-prompt.ts`) and session kinds (`sessions/session-kinds.ts`): the server resolves a session's prompt each time it sends an opening command, so an edit reaches a session the next time its node opens its runtime (a runtime already open keeps its prompt). The node's environment sections (`packages/node/src/runtime/system-prompt.ts`) need a node restart.
- `kill -USR2 <server pid>` rebuilds and swaps those handlers without changing files.

`buildDevBundle` bundles the transitive product sources and reloadable workspace packages. Third-party dependencies, builtins, **`@reins/node-protocol` and process-owned sources stay external**. Static references to process-owned local modules are rewritten to their original file URLs, so later product reloads cannot load edited copies and relative imports cannot resolve against `.dev-build`. Protocol schemas and error constructors must have one process-lifetime identity: the stable peer/dispatcher and reloadable product delivery must agree on `RpcFailure` and `DeliveryDeferred`. Inlining a second protocol copy into each bundle breaks error classification.

Bundled source retains its own `import.meta` locations. Each process builds into `.dev-build/<pid>/`, removed on exit; stale directories are removed at startup. A failed build/import leaves the previous references active. Reloads are debounced by 100 ms. Test and fixture files are ignored.

## What requires restart

The watcher logs a restart-required warning rather than half-reloading:

- Process/bootstrap, database and `node-link/` (socket/peer/hub, command outbox/dispatcher): see `restartRequired` for the exact rule.
- Schema migrations: applied only at database startup.
- `@reins/node-protocol`: **restart the server and node together**, especially for a version or required-field change. Do not try to hot-swap schemas under an established link.

`packages/node/src` is not watched. Changes to node runtime/tools/resources take effect only after restarting the node. Its active runs are interrupted; pending operations remain in server storage and can be resumed explicitly. The link is on **protocol version 6** (opening commands carry the session's `runtime` configuration and its task `branch`; node-contract.md *Session kinds*): a server and node of different versions refuse each other's hello, so roll it out with a coordinated server/node restart. The version was bumped for that change because the schemas are strict: across a mismatch every prompt would otherwise be refused as invalid params, a terminal failure, whereas refusing the hello keeps queued work in the outbox until both sides run the same version.

A real server restart still drops links. The node redials; server calls that were never sent wait for a new connection, while sent calls with unknown outcomes fail rather than being silently retried. See [node-contract.md](node-contract.md) for reconnect and recovery semantics.

## Usage

```sh
bun run dev                         # supervised server, node and frontend watchers
bun packages/backend/dev.ts         # server only, handler reload enabled
bun run start:node                  # separate node; restart it after node edits
```

For execution/protocol changes, work in a separate worktree and test against isolated ports, databases and sockets. Bring verified changes into the live checkout together, then restart the server/node at a deliberate idle point rather than relying on file-by-file hot reload.
