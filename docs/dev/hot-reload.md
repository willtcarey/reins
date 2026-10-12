# Dev Reload

Under `bun run dev`, the server's **app** hot reloads: its HTTP/browser handlers, product services, the session runtime code **and the node hub**. **The process** is the OS process, which lives until a restart; **the app** is the server's swappable code and what it builds (routes, ws handlers, the node hub and links, the node bundle, models): a dev reload replaces the app, production starts one. A reload closes every node's connection and each node redials; tool calls in flight ride through the redial ([ADR-020](../adr/020-reloadable-node-hub.md)). **Sessions run on the server** in runtimes the process keeps across reloads ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md), *Sessions on the server*): a reload neither pauses nor interrupts a run, and a running runtime keeps its code until it is idle. The node reloads only when asked (*Reloading the node*, [ADR-021](../adr/021-explicit-node-reload.md)). The process's own code (`ServerProcess`, the open sessions and the database connection included) and the protocol require a restart.

## Ownership

| Lifetime | What lives there | Who may keep a reference to it |
|---|---|---|
| **Process** (until a restart; `server-process.ts`, `process-state.ts`) | `ServerProcess` (`state.ts`): the database connection (`db`, opened once by `database.ts`: file, pragmas; each app migrates it, none closes it), `broadcast` (sends a frame to every browser connection; the process registers the sockets on open and close, so they outlive apps), `sessions` (`OpenSessions`: live runtimes, openings, submission chains, event seqs, the pause gate, the idle sweep), `credentials` (the credential store's per-provider lock), `app(signal?)` and `registerApp(app)` (the current app), `frontendDir`, `nodeSocket`. Also the HTTP server and the dev watcher | Anyone: each app (`AppState.process`), every session runtime, whichever app built it |
| **App** (one start to its stop; `server.ts`, replaced as a whole on every reload) | `AppState`: `process` plus its own node hub (`nodes`, connections and epochs), `/nodes/link` endpoint (`nodeLinks`), node bundle (`nodeBundle`) and the node socket listener; what it offers sessions (`App`, `session-runtime/session-app.ts`: `node()`, run lifecycle, the Reins tools), registered with the process from its start to its stop; its routes, ws handlers, models and module state (the stores' `getDb()`, set from `process.db` at each start) | The app's own code: routes, ws handlers, models, the hub. **Never a session runtime**: it reaches the current app per call, `(await process.app(signal)).…` |
| **Open session** (opened on use to its idle close; `session-runtime/`) | A live runtime (`OpenSession` in `OpenSessions.live`): its AgentHarness, storage (`PiStorageAdapter` on `process.db`), model runtime and credential store (over `process.credentials`), attachment cache, tools, built by one app's code and kept on it until closed | The process's `OpenSessions` only; an app calls it through `SessionRuntime` |
| **Request** (one HTTP request, browser message, tool call or script) | `Models` (`models/models.ts`) and what they build (a `Broadcast`, a credential store, `Sessions`, `Nodes`, `ProjectModel`) | That request's code |

**The rule:** a session runtime may keep the `ServerProcess`, never an `AppState` or an `App`; everything it needs of an app it reaches through `process.app()` at each call. The types enforce it where practical: a runtime is opened and built from a `ServerProcess` only (`openSessionRuntime`, `buildSessionRuntime`'s `RuntimeOpening`), and `App` hands out nothing session-bound to keep (its tool and lifecycle methods take the session ID; a runtime asks for its node again at each call). An app's routes, ws handlers and models take the `AppState` and reach the process through `state.process`; nothing copies a process field into the app's state.

`server.ts` exports one function, `start(process, {recoverRuns})`, and the process owner calls it with its `ServerProcess`. `start` makes the process's database the one the stores' `getDb()` returns (`setDb`) and prepares it (`prepareDatabase` in `db.ts`: migrations), builds the app's state (`createAppState` in `state.ts`: a new hub around the process), binds the node socket, registers what it offers sessions (`process.registerApp(sessionApp(state))`), resumes the runs a previous process left running when it is the process's first app (`recoverRuns`, session-runtime.md *Recovery*) and returns the app's `fetch` and browser `message` handlers (state bound in) and `stop`. `stop` unregisters the app (session calls wait for the next one; scripts it runs for them are aborted) and closes the hub and listener at once (closing the links ends their calls). It does not close the database: the process owns it ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md)).

The process owner orchestrates: on a reload it imports the new app, awaits the running app's `stop`, then starts the new one. Its WebSocket handlers are generic: a socket whose upgrade data carries handlers (`UpgradeData` in `state.ts`; a remote node's `/nodes/link`) is driven by them and belongs to the app that upgraded it, which closes it on `stop`; the process registers only the rest (browser sockets, `/ws`) as browser connections. So a change to the remote transport reloads like any other server code. The HTTP server's `maxPayloadLength` is the remote link's frame cap (16 MiB). Only one listener can bind the socket. Between the two apps, HTTP requests get 503 and browser messages an error ("Server reloading"); it lasts as long as opening the database. The process registers browser sockets itself, so a socket opened before a reload keeps working after it; requests already in flight finish on the app they started on.

**App module state is lost on a reload.** Anything an app keeps in module scope or in its state starts empty in the next app: OAuth logins in progress (`routes/oauth.ts`, docs/tech-debt.md), the session kinds registered at run time beyond the built-in ones (`registerSessionKind`), each node's announced build (the hub's, learned again at the node's next hello), the node bundle (built again). Keep what must outlive an app in the database or, when it cannot be, in the `ServerProcess` (a restart-only change).

## What a reload does to the node link

Closing the previous hub closes every node connection; the app's `stop` also closes its `/nodes/link` sockets, negotiated or not. Each node sees its connection close and redials (100 ms backoff); the new listener, or the new app's `/nodes/link`, accepts it and the new hub negotiates a fresh epoch. Nothing is handed over: every call that was in flight on the old connection ends with outcome unknown, and each kind recovers as it does after any dropped link ([node-transport.md](node-transport.md) *When things go wrong*):

- **Session runs** are on the server and keep running; their tool calls ride through the redial: a file operation is sent again, a command keeps running on the node and is picked up again by its ID (`RemoteExecutionEnv`, node-contract.md *Tool host*).
- **`execute`** runs on the server, not over the link: a script the stopped app was running for a session is aborted and fails that one tool call with "may have run"; one called during the reload gap waits for the next app.
- **Request-now calls and streams** of routes and git (skills, `fs.*`, `process.run`) fail to their caller with `unavailable`.
- **A submission** is answered by the app that took it (its ack or its error, to the socket that sent it); one cut off by the reload gap is resent by the browser under the same `clientId`, and converges.

Every app uses the process's database connection. A reload runs migrations on it again (only pending ones apply, so a new migration takes effect on the next reload).

## Sessions on the server

Sessions run on the server ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md)): submitted work goes to a session's runtime (`session-runtime/`; [session-runtime.md](session-runtime.md)). What follows is how runtimes live across reloads (in full: session-runtime.md *What the process keeps*, *Reaching the current app*).

- **The process owns the runtimes** (`ServerProcess.sessions`, an `OpenSessions` created in `process-state.ts`, typed in `state.ts`): live runtimes by session ID with their last activity, the openings in progress (concurrent opens of one session share one), live event seqs (per session, for the life of the process), each session's submission chain and the pause gate. An app opens a runtime with its own code (`openSessionRuntime` in `session-runtime/live.ts`, from the session's rows) and puts it in the map; a runtime keeps the code it was built with.
- **A runtime keeps the `ServerProcess`, never the app** (*Ownership*): its storage, attachments and credentials are on the process (`process.db`, `process.credentials`), its events go out through `process.broadcast`, and what it needs of an app (its node, run lifecycle, the Reins tools: `App`) it reaches through `process.app()` at each call. During the reload gap a call waits for the next app (`APP_WAIT_MS`, 30 s), then fails. Two surfaces cross between code of different apps, `App` (a runtime calls an app) and `SessionRuntime` (an app calls a runtime): an incompatible change to either, or to `ServerProcess` and `process-state.ts`, needs a restart. Errors crossing them are classified by fields (`outcome`, an error's `name`), never by class: each app has its own classes.
- **Idle runtimes are closed:** the process's sweep (every 30 s) closes a runtime idle 3 minutes and not streaming. When an app registers, runtimes earlier apps built are closed at once if idle and marked `retired` otherwise; a retired one is closed once idle, and an open meanwhile reopens it on the new code once it is idle (it keeps running its old code until then).
- **What a reload does to a run:** nothing it can see. Tool calls ride through the node's redial (`RemoteExecutionEnv`, node-contract.md *Tool host*); a script the stopped app was running for it is aborted and comes back "may have run". A reload recovers nothing: runtimes never left memory.
- **What a restart does:** SIGTERM/SIGINT pause every run at its next pause point (bounded by 3 s, then forced) and suspend it (`suspendSessions`), and the next process's first app resumes it (session-runtime.md *Recovery*); a crash cuts runs off wherever they are, and the next start resumes them the same way.

## What reloads

- Every local source under `packages/backend/src` the app reaches, the node hub and transport (`nodes/`) included, except the startup sources below.
- `@reins/telemetry` source used by the app.
- The session runtime (`session-runtime/`), the Reins system prompt (`sessions/system-prompt.ts`) and session kinds (`sessions/session-kinds.ts`): new runtimes are built by the new code; a runtime open at the reload keeps the code it was built with (and its kind's prompt) until it is closed, at once when idle, else as soon as it goes idle, and the session's next submission opens it on the new code.
- `kill -USR2 <server pid>` rebuilds and reloads without changing files.

`buildDevBundle` (`dev-build.ts`) bundles every local source and reloadable workspace package. Third-party dependencies, builtins and **`@reins/node-protocol` stay external**, one module instance for the process. The protocol stays external because the server and the node must change it together: the server keeps the protocol it started with until both restart, so a protocol edit never applies on one side only.

Bundled source retains its own `import.meta` locations. Each process builds into `.dev-build/<pid>/`, removed on exit; stale directories are removed at startup. A failed build/import leaves the previous app running (its node link untouched); if the new app fails to start (e.g. the socket cannot be bound), nothing serves (503) until the next reload. Reloads are debounced by 100 ms. Test and fixture files are ignored.

## What requires restart

The watcher logs a restart-required warning rather than half-reloading:

- **The process owner** (`PROCESS_OWNER_SOURCES` in `server-process.ts`): `index.ts`, `server-process.ts`, `dev-build.ts`, `process-state.ts` (the process's `ServerProcess`: open sessions, credential locks, the current app) and `database.ts` (the connection the process opens), and the surfaces between the process, runtimes and apps (`ServerProcess`, `App`, `SessionRuntime`, `OpenSessions` in `state.ts`) when a change breaks them: a runtime built by an older app calls the new one through them. `state.ts` itself reloads; the watcher cannot tell a breaking change, so restart after one.
- **The supervisor** (`supervisor.ts`, which spawns the server and the node): restart `bun run dev`. The watcher does not warn about it (no app imports it).
- `@reins/node-protocol`: **restart the server and node together**, especially for a version or required-field change. The link is on **protocol version 12**: a server and node of different versions refuse each other's hello, so tool calls wait until both run the same version (a node bundle is told to update instead, ADR-025). The schemas are strict, so a field change without a version bump would otherwise refuse calls as invalid params, a terminal failure.

A real server restart drops links the same way a reload does, and suspends its runs for the next process to resume (*Sessions on the server*). See [node-contract.md](node-contract.md) *When a node goes away* and [session-runtime.md](session-runtime.md) *Recovery*.

## Reloading the node

`packages/node/src` is not watched: reloading on every save would cut off the tool calls in flight on the node, including those of the agent that saved. Reload the node when you are ready ([ADR-021](../adr/021-explicit-node-reload.md); node-contract.md *Reloading a node*):

```sh
bun run node:reload                 # the local node; --force, or a node ID, as arguments
```

or from an agent's `execute` script, `await api.nodes.reload()` (the calling session's node), or `POST /api/nodes/:nodeId/reload`. The node first checks that its new code builds and refuses with the error if not. Otherwise the call returns at once: it does not wait for the reload, so an agent can reload the node it runs on. The node then exits once no command (a bash call) is running on it, and the supervisor starts it again at once. Sessions run on the server, so no run is paused: a running command finishes and its result reaches the run first; a command started meanwhile is refused and sent again by the server once the node is back, and any other tool call waits for the node and runs on the new code. A command that runs long holds the reload up for up to 60 s; then the reload is cancelled (logged by the node, naming the command) and the command runs on, unless `force` cuts it off (it comes back "outcome unknown"). A bash call running `bun run node:reload` is a command too, but it ends as soon as the reload answers, so it does not hold it up. A node run on its own (`bun run start:node`) has nothing to restart it and refuses: restart it yourself.

A node restart interrupts only the tool calls in flight on it: a command it lost comes back to the model as "outcome unknown" (node-contract.md *Tool host*).

## Tests

`supervisor.process-test.ts` reloads a supervised node over HTTP while a run is in flight on the server: the node restarts at once and the run's tool call runs once on the new process, nothing paused. `server-process.process-test.ts` (`bun run test:process`) kills a node mid-run (the run goes on), stops a server with SIGTERM mid-run (paused and suspended; the next process resumes it and its tool call runs once), kills one mid-request (the next process asks it again), and reloads a real dev server with `SIGUSR2` mid-run: the run goes on, never paused, and a browser socket opened before the reload submits after it. `integration/session-across-reload.test.ts` replaces the app under a session running on the server mid-tool-call (its run continues and settles through the new app), and `process-state.test.ts` covers the idle sweep, retiring on a new app and waiting for an app during the gap. `nodes/node-hub.test.ts` covers a new connection superseding a node's old one (its call in flight ends with outcome unknown).

## Usage

```sh
bun run dev                         # supervised server, node and frontend watchers
bun packages/backend/dev.ts         # server only, app reload enabled
bun run start:node                  # separate node; restart it after node edits (it cannot reload itself)
bun run node:reload                 # reload the supervised node after node edits
```

For protocol changes, work in a separate worktree and test against isolated ports, databases and sockets, then restart the server and node together at a deliberate idle point.
