# Dev Reload

Under `bun run dev`, the server's handler module hot reloads: HTTP/browser handlers, product services **and the node hub**. A reload closes the node's connection and the node redials; work in flight recovers through the link's resend and link-loss paths ([ADR-020](../adr/020-reloadable-node-hub.md)). **Pi sessions stay on the node** and keep running through the redial. The process owner's own code, database startup, the protocol and node code require a restart.

## Ownership

```text
server-process.ts (never reloads)
  HTTP server: requests and browser socket messages go to the running load
  browser clients: registered on socket open/close, outlive reloads
  dev watcher
    ↑ buildDevBundle(server.ts), import, await running.stop(), start(...)

one handler load (server.ts start/stop; replaced as a whole on every reload)
  database: openDb (migrations, outbox recovery), closed on stop
  routes, ws message handler, product services
  ServerState (createServerState): the process's clients + a new node hub
  node hub: connections, epochs, dispatcher
  node socket listener → state.nodes.accept

node process (never hot reloads)
  Pi runtimes, execution environments, in-memory caches
```

`server.ts` exports one function, `start({clients, frontendDir, nodeSocket})`. It opens the load's database (`openDb`: migrations, then outbox recovery), builds the load's state (`createServerState` in `state.ts`: a new hub serving this load's product code), starts the hub and binds the node socket, and returns the load's `fetch` and browser `message` handlers (state bound in) and `stop`. `stop` closes the hub and listener at once, waits for the deliveries in flight to settle (closing the links ends their calls, so they requeue promptly) and closes the database.

The process owner orchestrates: on a reload it imports the new module, awaits the running load's `stop`, then starts the new one. Only one listener can bind the socket, and the new load's outbox recovery must not run while the old dispatcher could still settle a delivery. Between the two, HTTP requests get 503 and browser messages an error ("Server reloading"); it lasts as long as opening the database. The process registers browser sockets itself (`clients`), so a socket opened before a reload keeps working after it; requests already in flight finish on the load they started on.

## What a reload does to the node link

Closing the previous hub closes every node connection and stops its dispatcher. The node sees its connection close and redials (100 ms backoff); the new listener accepts it and the new hub negotiates a fresh epoch. Nothing is handed over: every call that was in flight on the old connection ends with outcome unknown, and each kind recovers as it does after any dropped link ([node-transport.md](node-transport.md) *When things go wrong*):

- **Outbox commands** (prompt, steer, setModel) in delivery are requeued and redelivered to the new hub; replays converge (node-contract.md *Replay idempotency*). Input submitted while the node is redialing waits in the outbox.
- **Node storage commits and lifecycle reports** whose reply was lost are resent on the new connection and recognised as repeats (`commitId`, `reportId`); unsent ones wait for it. The node's hello lists its running sessions, so the new hub leaves their runs alone.
- **`script.execute`** is not resent (it has side effects): a drop during it fails that one tool call with "may have run".
- **Other node→server calls in flight** fail as on any drop: credential and attachment calls fail their caller, and a `storage.read` in flight fails its run (Pi faults on any storage error; the run's operation stays pending and can be resumed). Reads are short, so this is rare, but they are not resent.
- **Request-now calls and streams** (abort, resume, skills, `fs.*`, `process.run`) fail to their caller with `unavailable`.
- **Submission failure recipients** live on the browser client (`WsClient.submissions`), not the hub, so an input that fails after a reload still reaches the client that submitted it.

Each load owns its database connection. A reload runs migrations again (only pending ones apply, so a new migration takes effect on the next reload) and outbox recovery, which finds nothing to requeue: the previous load requeued its interrupted deliveries before its `stop` resolved.

## What reloads

- Every local source under `packages/backend/src` the handler module reaches, the node hub and transport (`nodes/`) included, except the startup sources below.
- `@reins/telemetry` source used by product handlers.
- The Reins system prompt (`sessions/system-prompt.ts`) and session kinds (`sessions/session-kinds.ts`): the server resolves a session's prompt each time it sends an opening command, so an edit reaches a session the next time its node opens its runtime (a runtime already open keeps its prompt). The node's environment sections (`packages/node/src/runtime/system-prompt.ts`) need a node restart.
- `kill -USR2 <server pid>` rebuilds and reloads without changing files.

`buildDevBundle` (`dev-build.ts`) bundles every local source and reloadable workspace package. Third-party dependencies, builtins and **`@reins/node-protocol` stay external**, one module instance for the process. The protocol stays external because the node does not hot reload: the server keeps the protocol it started with until both restart, so a protocol edit never applies on one side only.

Bundled source retains its own `import.meta` locations. Each process builds into `.dev-build/<pid>/`, removed on exit; stale directories are removed at startup. A failed build/import leaves the previous load running (its node link untouched); if the new load fails to start (e.g. the socket cannot be bound), nothing serves (503) until the next reload. Reloads are debounced by 100 ms. Test and fixture files are ignored.

## What requires restart

The watcher logs a restart-required warning rather than half-reloading:

- **The process owner** (`PROCESS_OWNER_SOURCES` in `server-process.ts`): `index.ts`, `server-process.ts`, `dev-build.ts`.
- `@reins/node-protocol`: **restart the server and node together**, especially for a version or required-field change. The link is on **protocol version 7**: a server and node of different versions refuse each other's hello, so queued work stays in the outbox until both run the same version. The schemas are strict, so a field change without a version bump would otherwise refuse calls as invalid params, a terminal failure.

`packages/node/src` is not watched. Changes to node runtime/tools/resources take effect only after restarting the node. Its active runs are interrupted; pending operations remain in server storage and can be resumed explicitly.

A real server restart drops links the same way a reload does, except that nothing settles first: startup recovery requeues commands whose delivery the restart interrupted. See [node-contract.md](node-contract.md) for reconnect and recovery semantics.

## Tests

`server-process.process-test.ts` (`bun run test:process`) reloads a real dev server with `SIGUSR2`: a run in flight across the reload commits and settles over the redialed link, a command dispatching across it is requeued and delivered once, input queued while the node is away is delivered, a browser socket opened before the reload submits after it, and the new load reopens the database only after the old one settled. `nodes/node-hub.test.ts` replaces a hub and its listener in process and loses a commit's reply across the switch: the node resends it and the new hub answers it from its record.

## Usage

```sh
bun run dev                         # supervised server, node and frontend watchers
bun packages/backend/dev.ts         # server only, handler reload enabled
bun run start:node                  # separate node; restart it after node edits
```

For protocol changes, work in a separate worktree and test against isolated ports, databases and sockets, then restart the server and node together at a deliberate idle point.
