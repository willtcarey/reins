# Dev Reload

Under `bun run dev`, the server's handler module hot reloads: HTTP/browser handlers, product services, the session runtime code **and the node hub**. A reload closes the node's connection and the node redials; work in flight recovers through the link's resend and link-loss paths ([ADR-020](../adr/020-reloadable-node-hub.md)). **Sessions run on the server** in runtimes the process keeps across reloads ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md), *Sessions on the server*): a reload neither pauses nor interrupts a run. The node reloads only when asked (*Reloading the node*, [ADR-021](../adr/021-explicit-node-reload.md)). The process owner's own code and the protocol require a restart.

## Ownership

```text
server-process.ts (never reloads)
  HTTP server: requests and browser socket messages go to the running load
  browser clients: registered on socket open/close, outlive reloads
  database connection: opened once (database.ts: file, pragmas), handed to every load, never closed by one
  sessions (process-state.ts): live session runtimes, openings, event seqs, pause gate,
    the load serving now; the idle sweep
  any other WebSocket: driven by the handlers its load put in its upgrade data
  dev watcher
    ↑ buildDevBundle(server.ts), import, await running.stop(), start(...)

one handler load (server.ts start/stop; replaced as a whole on every reload)
  database: prepareDatabase on the process's connection (migrations)
  routes, ws message handler, product services
  ServerState (createServerState): the process's clients and sessions + a new node hub
  node hub: connections, epochs
  node socket listener → state.nodes.accept
  /nodes/link (state.nodeLinks): remote nodes' WebSockets → state.nodes.accept
  LoadServices (session-runtime/load-services.ts): what the process's runtimes call, served
    from start (sessions.serve) until stop

node process (restarted on its new code by an explicit reload)
  tools and files of its sources' checkouts (the tool host)
```

`server.ts` exports one function, `start({db, clients, sessions, frontendDir, nodeSocket, recoverRuns})`. It prepares the process's database connection (`prepareDatabase` in `db.ts`: migrations), builds the load's state (`createServerState` in `state.ts`: a new hub serving this load's product code), binds the node socket, serves the process's sessions (`sessions.serve(loadServices(state))`), resumes the runs a previous process left running when it is the process's first load (`recoverRuns`, node-contract.md *Crash recovery*) and returns the load's `fetch` and browser `message` handlers (state bound in) and `stop`. `stop` stops serving the sessions (their calls wait for the next load; scripts it runs for them are aborted) and closes the hub and listener at once (closing the links ends their calls). It does not close the database: the process owns it ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md)).

The process owner orchestrates: on a reload it imports the new module, awaits the running load's `stop`, then starts the new one. Its WebSocket handlers are generic: a socket whose upgrade data carries handlers (`UpgradeData` in `state.ts`; a remote node's `/nodes/link`) is driven by them and belongs to the load that upgraded it, which closes it on `stop`; the process registers only the rest (browser sockets, `/ws`) as clients. So a change to the remote transport reloads like any other server code. The HTTP server's `maxPayloadLength` is the remote link's frame cap (16 MiB). Only one listener can bind the socket. Between the two loads, HTTP requests get 503 and browser messages an error ("Server reloading"); it lasts as long as opening the database. The process registers browser sockets itself (`clients`), so a socket opened before a reload keeps working after it; requests already in flight finish on the load they started on.

## What a reload does to the node link

Closing the previous hub closes every node connection; the load's `stop` also closes its `/nodes/link` sockets, negotiated or not. Each node sees its connection close and redials (100 ms backoff); the new listener, or the new load's `/nodes/link`, accepts it and the new hub negotiates a fresh epoch. Nothing is handed over: every call that was in flight on the old connection ends with outcome unknown, and each kind recovers as it does after any dropped link ([node-transport.md](node-transport.md) *When things go wrong*):

- **Session runs** are on the server and keep running; their tool calls ride through the redial (`RemoteExecutionEnv`, node-contract.md *Tool host*).
- **Node storage commits and lifecycle reports** whose reply was lost are resent on the new connection and recognised as repeats (`commitId`, `reportId`); unsent ones wait for it.
- **`script.execute`** is not resent (it has side effects): a drop during it fails that one tool call with "may have run".
- **Other node→server calls in flight** fail as on any drop: credential and attachment calls fail their caller, and a `storage.read` in flight fails its run (Pi faults on any storage error; the run's operation stays pending and can be resumed). Reads are short, so this is rare, but they are not resent.
- **Request-now calls and streams** (abort, resume, skills, `fs.*`, `process.run`) fail to their caller with `unavailable`.
- **A submission** is answered by the load that took it (its ack or its error, to the socket that sent it); one cut off by the reload gap is resent by the browser under the same `clientId`, and converges.

Every load uses the process's database connection. A reload runs migrations on it again (only pending ones apply, so a new migration takes effect on the next reload).

## Sessions on the server

Sessions run on the server ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md)): submitted work goes to a session's runtime (`session-runtime/`; node-contract.md *Submitted work*). What follows is how runtimes live across reloads.

- **The process owns the runtimes** (`ProcessSessions` in `process-state.ts`, typed in `state.ts`): live runtimes by session ID with their last activity, the openings in progress (concurrent opens of one session share one), live event seqs (per session, for the life of the process), each session's submission chain, the pause gate and the load serving now. A load opens a runtime with its own code (`openSessionRuntime` in `session-runtime/live.ts`, from the session's rows) and puts it in the map; a runtime keeps the code it was built with.
- **A runtime reaches a load only through `ProcessSessions.load()`**, at each call, never from the load that built it: its node (`LoadServices.node`, the hub), credentials (the load's store, with its per-provider refresh lock), `runStarted`/`runSettled`, the Reins tools and the attachment store. During the reload gap a call waits for the next load (`LOAD_WAIT_MS`, 30 s), then fails. Its storage is `PiStorageAdapter` on the process's connection directly. Two surfaces cross between code of different loads, `LoadServices` (a runtime calls a load) and `LiveRuntime` (a load calls a runtime): an incompatible change to either, or to `process-state.ts`, needs a restart. Errors crossing them are classified by fields (`outcome`, an error's `name`), never by class: each load has its own classes.
- **Idle runtimes are closed:** the process's sweep (every 30 s) closes a runtime idle 3 minutes and not streaming. When a load starts serving, runtimes earlier loads built are closed at once if idle and marked `retired` otherwise; a retired one is closed once idle, and an open meanwhile reopens it on the new code once it is idle (it keeps running its old code until then).
- **What a reload does to a run:** nothing it can see. Tool calls ride through the node's redial (`RemoteExecutionEnv`, node-contract.md *Tool host*); a script the stopped load was running for it is aborted and comes back "may have run". A reload recovers nothing: runtimes never left memory.
- **What a restart does:** SIGTERM/SIGINT pause every run at its next pause point (bounded by 3 s, then forced) and suspend it (`suspendSessions`), and the next process's first load resumes it (node-contract.md *Crash recovery*); a crash cuts runs off wherever they are, and the next start resumes them the same way.

## What reloads

- Every local source under `packages/backend/src` the handler module reaches, the node hub and transport (`nodes/`) included, except the startup sources below.
- `@reins/telemetry` source used by product handlers.
- The Reins system prompt (`sessions/system-prompt.ts`), session kinds (`sessions/session-kinds.ts`) and the environment sections (`session-runtime/environment.ts`): the server resolves a session's prompt each time it opens its runtime, so an edit reaches a session the next time its runtime opens (a runtime already open keeps its prompt; one a reload retires is reopened on the new code once idle).
- `kill -USR2 <server pid>` rebuilds and reloads without changing files.

`buildDevBundle` (`dev-build.ts`) bundles every local source and reloadable workspace package. Third-party dependencies, builtins and **`@reins/node-protocol` stay external**, one module instance for the process. The protocol stays external because the server and the node must change it together: the server keeps the protocol it started with until both restart, so a protocol edit never applies on one side only.

Bundled source retains its own `import.meta` locations. Each process builds into `.dev-build/<pid>/`, removed on exit; stale directories are removed at startup. A failed build/import leaves the previous load running (its node link untouched); if the new load fails to start (e.g. the socket cannot be bound), nothing serves (503) until the next reload. Reloads are debounced by 100 ms. Test and fixture files are ignored.

## What requires restart

The watcher logs a restart-required warning rather than half-reloading:

- **The process owner** (`PROCESS_OWNER_SOURCES` in `server-process.ts`): `index.ts`, `server-process.ts`, `dev-build.ts`, `process-state.ts` and `database.ts`, and the surfaces between runtimes and loads (`LoadServices`, `LiveRuntime` in `state.ts`) when a change breaks them.
- `@reins/node-protocol`: **restart the server and node together**, especially for a version or required-field change. The link is on **protocol version 9**: a server and node of different versions refuse each other's hello, so tool calls wait until both run the same version. The schemas are strict, so a field change without a version bump would otherwise refuse calls as invalid params, a terminal failure.

A real server restart drops links the same way a reload does, and suspends its runs for the next process to resume (*Sessions on the server*). See [node-contract.md](node-contract.md) for reconnect and recovery semantics.

## Reloading the node

`packages/node/src` is not watched: reloading on every save would cut off the tool calls in flight on the node, including those of the agent that saved. Reload the node when you are ready ([ADR-021](../adr/021-explicit-node-reload.md); node-contract.md *Reloading a node*):

```sh
bun run node:reload                 # the local node; --force, or a node ID, as arguments
```

or from an agent's `execute` script, `await api.nodes.reload()` (the calling session's node), or `POST /api/nodes/:nodeId/reload`. The node first checks that its new code builds and refuses with the error if not. Otherwise the call returns at once: it does not wait for the reload, so an agent can reload the node it runs on. The node then exits once no command (a bash call) is running on it, and the supervisor starts it again at once. Sessions run on the server, so no run is paused: a running command finishes and its result reaches the run first; a command started meanwhile is refused and sent again by the server once the node is back, and any other tool call waits for the node and runs on the new code. A command that runs long holds the reload up for up to 60 s; then the reload is cancelled (logged by the node, naming the command) and the command runs on, unless `force` cuts it off (it comes back "outcome unknown"). A bash call running `bun run node:reload` is a command too, but it ends as soon as the reload answers, so it does not hold it up. A node run on its own (`bun run start:node`) has nothing to restart it and refuses: restart it yourself.

A node restart interrupts only the tool calls in flight on it: a command it lost comes back to the model as "outcome unknown" (node-contract.md *Tool host*).

## Tests

`supervisor.process-test.ts` reloads a supervised node over HTTP while a run is in flight on the server: the node restarts at once and the run's tool call runs once on the new process, nothing paused. `server-process.process-test.ts` (`bun run test:process`) kills a node mid-run (the run goes on), stops a server with SIGTERM mid-run (paused and suspended; the next process resumes it and its tool call runs once), kills one mid-request (the next process asks it again), and reloads a real dev server with `SIGUSR2` mid-run: the run goes on, never paused, and a browser socket opened before the reload submits after it. `integration/session-across-reload.test.ts` replaces the load under a session running on the server mid-tool-call (its run continues and settles through the new load), and `process-state.test.ts` covers the idle sweep and retiring on a new load. `nodes/node-hub.test.ts` replaces a hub and its listener in process and loses a commit's reply across the switch: the node resends it and the new hub answers it from its record.

## Usage

```sh
bun run dev                         # supervised server, node and frontend watchers
bun packages/backend/dev.ts         # server only, handler reload enabled
bun run start:node                  # separate node; restart it after node edits (it cannot reload itself)
bun run node:reload                 # reload the supervised node after node edits
```

For protocol changes, work in a separate worktree and test against isolated ports, databases and sockets, then restart the server and node together at a deliberate idle point.
