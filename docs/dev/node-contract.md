# Node contract

A **node** runs agent sessions: it owns the Pi runtime, the checkout the agent works in, and each session's canonical AgentHarness storage. The **server** never runs a session. It owns product state (projects, tasks, sessions, settings, credentials), a replica of every session's storage, the durable command outbox that delivers work to nodes, session relocation between nodes, and the browser UI/API.

Today there is one kind of node: a local process (`packages/node`) on the server's machine, linked over a Unix socket. Remote nodes are not built; see [the node architecture plan](../plans/node-architecture.md) for what is open. Decisions behind this design are recorded in ADRs [008](../adr/008-server-hub-session-relocation.md)–[014](../adr/014-shared-protocol-and-storage-packages.md).

| Concern | Server (`packages/backend`) | Node (`packages/node`) |
|---|---|---|
| Session storage | Replica of every session's Pi tables (canonical only for a session at rest on the server) | Canonical Pi storage of the sessions placed on it (`~/.reins/node/storage.db`) |
| Execution | None | Pi runtime, native tools, Reins tools (which call the server), skill/resource discovery, task branch checkout |
| Commands | Durable outbox, per-session ordering, placement state | Idempotent command handlers; no per-command records |
| Credentials | Sole holder and sole OAuth refresher | Reads them over the link; caches in memory only |
| Attachments | Durable bytes for the browser and for hydration | Verified execution cache; node-created images until uploaded |

## Packages and import boundaries

The server does not depend on the node package. What both sides need lives in two shared packages ([ADR-014](../adr/014-shared-protocol-and-storage-packages.md)):

| Package | Contents | Depends on |
|---|---|---|
| `@reins/node-protocol` (`packages/node-protocol`) | Everything about talking over the link: the server's durable command vocabulary (`contract.ts`: the commands `node_command_outbox` stores, their results, `sessionConfiguration`, `promptContent`, node error codes, attachment limits, `deliveryPolicy()`); wire schemas, `methods`, `capability`, hello, `NodeSessionBinding` (`schema.ts`); `nodeError`/`NodeRejection`/`serverCallRejection` (`errors.ts`); the runtime event and message shapes `session.event` carries plus `finalReply` (`events.ts`); the Reins tool names and call surface `ReinsToolCalls` (`tools.ts`); and the RPC plumbing both ends run: the JSON-RPC peer with timeouts, notifications and heartbeat (`peer.ts`), NDJSON Unix-socket framing (`ndjson.ts`), local-link constants (`local-link.ts`) and the node end of a connection (`createNodeConnection`, `connection.ts`). | `zod` only (plus runtime builtins: `node:os`/`node:path`, Bun socket types) |
| `@reins/pi-sql-storage` (`packages/pi-sql-storage`) | Pi's AgentHarness `Storage` on SQLite (`PiStorageAdapter`, including the replication hook the node's outbox and the server's replica apply use), snapshot paging (`readPiSnapshotPage`), digests (`piSnapshotSummary`, `summarizePiSnapshot`, `samePiSnapshot`) and verbatim writes (`writePiSnapshot`). It reads and writes the shared table layout (`sessions.harness_next_seq`, `session_messages`, `pi_values`, `pi_lists`, `pi_usage`); each side creates those tables in its own migration ledger. | Pi (`pi-agent-core`, `pi-ai` types), `bun:sqlite` |
| `@reins/node` (`packages/node`) | Node-only: `./node` (`startNode`, the `Node` API), `./node-connection` (`connectNode`), `./local-link` (`connectLocalNode`), `./storage` (`openNodeDb`, binding, outbox, attachment cache tables), `./runtime`, `./pi-runtime`, `./host-tools`, `./reins-tools`, `./resources`, `./system-prompt` (runtime assembly, see [node-runtime.md](node-runtime.md)), `main.ts`, credentials. | both above, Pi |

Entry points: `@reins/node-protocol` (one barrel, `src/index.ts`), `@reins/node-protocol/testing` (the in-memory loopback socket pair and `scriptedCommandHandlers`; tests only) and `@reins/pi-sql-storage`. pi-sql-storage does not import node-protocol: the snapshot row type is its own, and the wire schema (`snapshotRow` in `schema.ts`) validates the same shape.

The server's own Pi model context (catalog, model validation, OAuth provider metadata, one-shot utility asks) is built directly from Pi with the server's credential store (`runtimes/pi/factory.ts`), not from the node's runtime. Utility asks carry only their system prompt: the server has no source checkout, so it discovers no skills or context files.

Boundaries (Oxlint rules in `scripts/oxlint-plugin-reins.cjs`, also checked by `node-dependency-boundary.test.ts`):

- `reins/node-import-boundary`: backend production code never imports `@reins/node` or `@reins/node/*` (exact name or `@reins/node/` prefix, so `@reins/node-protocol` is allowed), nor any package's `src/` path. **Exception:** `runtimes/claude_agent_sdk/**`, the dormant Claude runtime (unreachable from `server.ts`, kept compiling until it is rebuilt), still imports `@reins/node/resources` and `@reins/node/system-prompt`; the rule is off there. Backend tests may import `@reins/node` (they start in-process nodes).
- `reins/server-node-process-boundary`: non-test server code (the Claude exception included) never imports `@reins/node/node`, `@reins/node/node-connection`, `@reins/node/local-link`, `@reins/node/storage` or `@reins/node-protocol/testing`. No backend production code calls a `Node` method; everything crosses the link.
- `reins/node-protocol-isolation`: `packages/node-protocol` imports only `zod`, its own modules and runtime builtins.
- `reins/pi-sql-storage-isolation`: `packages/pi-sql-storage` imports only Pi, its own modules and runtime builtins (never the node, the server or node-protocol).
- `reins/node-implementation-isolation`: node code never imports server code.
- No server code singles out a node ID. The seeded `internal` node row is migration data only.

## Process model

The server and the local node are separate processes that meet only on the node socket (*Transport*).

- **Server-only** (`bun run start:server`, `packages/backend/src/index.ts` → `server-process.ts`): opens the product database under `REINS_DATA_DIR`, listens on HTTP and on the node socket. It never starts a node or opens node SQLite.
- **Node-only** (`bun run start:node`, `packages/node/src/main.ts`): opens only node storage (`~/.reins/node/storage.db`), starts the node and dials the socket. Logs go to stdout/stderr with a `[node]` prefix. A node migration failure exits nonzero. It announces `REINS_NODE_ID`, by default `DEFAULT_LOCAL_NODE_ID` (`"internal"`, the node row the server's migrations seed). `REINS_NODE_TEST_FAUX_PROVIDER` is a **test-only** hook (`src/testing/faux-provider.ts`) registering a scripted model for process-level tests; never set it in production.
- **Combined** (`bun run start`, `bun run dev`; `packages/backend/src/supervisor.ts start|dev`): spawns the server (in dev, `packages/backend/dev.ts` with handler hot reload), the node and, in dev, the frontend watchers. Both inherit the environment, so they agree on `REINS_NODE_SOCKET`. The server exiting stops everything. A node that exits is restarted with exponential backoff (1 s doubling to 30 s, reset after 30 s of uptime). Nothing watches node code, in `dev` either: the node runs new code only after it is restarted (see [hot-reload.md](hot-reload.md)). SIGTERM/SIGINT: SIGTERM to every child, SIGKILL after 8 s, exit 0. The Docker image runs `supervisor.ts start`.

**Startup ordering:** either may start first. A node started before the server redials with backoff (100 ms to 5 s); a server started before the node accepts commands and holds submitted work in its outbox until the node negotiates (immediate controls return `unavailable`).

**Shutdown:** the server on SIGTERM/SIGINT exits through `exit`, removing its socket file. The node on SIGTERM/SIGINT stops redialing and closes its connection first (no new commands), then `Node.shutdown()` **aborts** active runs and closes every live runtime, bounded by 5 s, so each run settles durably (its reply, commits and `session.settled` wait in the node outbox and replay on the next connection); then it closes the node database and exits 0. It does not wait for runs to finish: runs can last longer than a supervisor would wait. A node killed without shutdown (SIGKILL, crash) leaves its run pending in Pi and the session's server activity `running`; after restart the session continues once the pending operation is resumed (`POST /api/sessions/:id/resume`), and a prompt admitted before that waits behind it (crash recovery is open work).

## Transport

Everything above framing (schemas, `node.hello` negotiation, epochs, outbox replay, lifecycle reports, credentials) is transport-neutral: `createRpcPeer(socket, handlers, options)` needs only a `WireSocket` (send a text frame, receive frames, close).

The production local link is **JSON-RPC 2.0 over a Unix domain stream socket with newline-delimited frames** ([ADR-012](../adr/012-ndjson-unix-socket-local-link.md)). The server process owner (`server-process.ts`) owns the listener and routes each connection to the currently installed handler (`acceptNodeConnection` → `state.nodes.accept`); the node dials it (`connectLocalNode`). Remote nodes will use WebSocket + TLS with enrollment (not built) and reuse everything above the `WireSocket`.

**Framing** (`ndjson.ts` in `@reins/node-protocol`, both ends): each frame is the UTF-8 of one `JSON.stringify` string followed by `\n`; `send` rejects a frame containing a raw newline. The receiver splits on the newline byte, reassembles frames split anywhere (including mid-character), delivers several frames per chunk in order and decodes each whole with a fatal decoder (invalid UTF-8 closes). A partial frame crossing the cap closes the connection, so buffering is bounded. Writes the socket does not accept are queued in order and flushed on `drain` (the outbound queue is not capped; the heartbeat closes a peer that stops reading). Closing either end drops queued bytes and closes the peer; in-flight calls fail with outcome unknown.

**Endpoint and permissions** (`node-transport/local-socket.ts`): default `~/.reins/run/node.sock` (`defaultLocalNodeSocketPath()`, not under `REINS_DATA_DIR`, so both sides agree without configuration); `REINS_NODE_SOCKET` overrides it for both processes. The path must be absolute and at most 103 bytes. The parent directory is created 0700 (an existing one must be owned by the user and not group/world-writable) and the socket chmodded 0600. **Local authentication is these file permissions.** On startup a non-socket path fails, a socket something still accepts on fails ("Another process is already listening on the node socket"), and a stale socket is removed. The listener is separate from the browser HTTP/WebSocket server.

**Negotiation and identity:** the node calls `node.hello {minVersion, maxVersion, capabilities, nodeId}`; the server answers `{version: 1, capabilities, epoch}` with a fresh epoch per connection. The hub serves a connection only for a node ID with a `nodes` row (unknown IDs get `-32003` "Unknown node: <id>"; the node closes and redials). Handlers are resolved per connection from the announced ID. A connection becomes its node's link once it negotiates; that node's previous link is then closed (other nodes' links are untouched) and the dispatcher woken. The old connection's epoch is never accepted on the new one (`-32003`), and the node rejects commands carrying an epoch it was not issued. The server may deliver queued work in the same read as the hello reply, so the node's command handlers wait for their side of the negotiation to settle before checking the epoch. Enrollment and authentication of remote nodes are future work: today a `nodes` row plus socket permissions are the whole authorization. `GET /api/health` reports `nodes: [{id, name, connected}]`.

**Node reconnect** (`connectLocalNode`): redials whenever a dial fails or the connection closes, 100 ms to 5 s with equal jitter, reset once a connection negotiates. Each connection is a new attach: every session's pending node outbox replays and the credential cache is dropped. `stop()` closes the connection and cancels redials; call it before `Node.shutdown()`.

**Hello timeout:** on the socket link both ends close a connection that has not negotiated within 10 s (`HELLO_TIMEOUT_MS`).

**Heartbeat** (peer option; on for the socket link): every 10 s each side sends a `node.ping` notification, handled inside the peer. Any received frame counts as heard; after 3 intervals with nothing received the connection is closed. Timers are injectable for tests.

**Frame caps:** the peer default is 1 MiB (`DEFAULT_MAX_FRAME_BYTES`); the socket link uses 64 MiB (`LOCAL_MAX_FRAME_BYTES`) both ways; the in-memory test loopback is uncapped. An outbound frame over the cap is never sent: that call rejects with `FRAME_TOO_LARGE` (`-32004`, terminal) and the connection stays open. Attachments cross in 512 KiB chunks; `session.committed` batches are not chunked, so a batch over the cap never delivers and holds back its session's later node outbox rows. A remote (smaller-cap) link needs chunked commits and a prompt size bound.

**Errors on the wire:** node rejections are `-32000` whose `error.data` is the `NodeError` `{code, message, retryable}`; exceptions in node code use the same code with `{code: "internal", retryable: false}`. The peer validates `error.data` per call, bounds it to 8 KiB and messages to 2048 chars, and treats malformed error responses as `-32603` and closes. Server application errors are `-32000` with a message only. Other codes: `-32602` invalid params, `-32002` busy, `-32003` stale epoch/not negotiated.

**Server handler hot reload** (dev): the listener lives in `server-process.ts`, which never reloads. A reload installs the new handler (its new hub becomes `state.nodes`), then the old handler's uninstall closes the old hub (dispatcher stopped, node connections closed). The node process is untouched: its runs continue (live events emitted with no connection are dropped; commits and reports wait in its outbox). It redials, reaches the new handler, and replays its outbox (idempotent). An in-flight command on the old connection fails with outcome unknown and is requeued; work submitted in the gap is deferred; both are delivered once over the new connection. The database is process state: `server-process.ts` opens it once (`openDb`: migrations, then `recoverInterruptedDispatches`) and injects it into every loaded handler (`setDb`), so a reload never treats the old handler's in-flight commands as interrupted. Tested with real processes in `server-process.test.ts`. `kill -USR2 <server pid>` triggers a reload without a source change.

**Test links:** backend tests connect an in-process node (`connectLoopbackNode`, `loopbackNodeFor`) or a scripted one (`useFakeNode`, any node ID) through `__tests__/helpers/loopback-node.ts`, which hands the server end to the hub's real `accept`; `createServerState({ loopbackNode: true })` connects one as the seeded node. The loopback has no hello timeout or heartbeat and redials when its link closes, as the node process does. Production code has no test hook in the link path.

## Wire method naming

Methods are named for what is happening, not which side serves them. All names live in `methods` (`@reins/node-protocol`).

- Commands sent to the node are imperatives named after their op: `session.provision`, `session.prompt`, `session.steer`, `session.setModel`, `session.abort`, `session.resumePending`, `session.hydrate`, `session.delete`.
- Requests name the resource: `attachment.fetch`, `attachment.store`, `session.snapshot`, `script.execute`, `script.search`, `project.createTask`, `credentials.get`, `credentials.refresh`, `credentials.list`, `skills.list`.
- Durable reports are past tense: `session.committed`, `session.started`, `session.settled`.
- Live notifications: `session.event`, `script.cancel`.
- Only connection-level methods use the `node.` prefix: `node.hello`, `node.ping`.

Server→node methods are negotiated capabilities (`capability` enum). Node→server methods are base protocol v1: served only after `node.hello` and only with the issued epoch (`-32003` otherwise).

**Extension point:** a new node capability (future plugins included) is a wire method: a name in `methods`, strict params/result schemas in `schema.ts` (`@reins/node-protocol`), a `capability` entry for server→node methods, and a handler in the peer's handler record. The server calls it only once `node.hello` negotiated the capability.

## Node API

`@reins/node/node` is the node's in-process API; `connectNode` (`@reins/node/node-connection`) serves it over a connection and nothing else calls it outside tests.

- **Lifecycle.** `openNodeDb(path)` (`@reins/node/storage`; `:memory:` in tests) opens node storage and applies node migrations ([node-migrations.md](node-migrations.md)); the caller owns the connection. `startNode(db)` starts a new, independent node over it (its runtimes, outbox drain, event seqs, credential cache and connections are its own; no module globals) and takes no in-process server dependency. `shutdown()` is the one teardown: refuses new commands (`Node stopped`), aborts active runs, closes every live runtime and waits for serialized work; close the connection before it and the database after.
- **Commands.** One method per server→node wire method, taking its params (without `epoch`) and returning its wire result: `provision → {provisioned}`, `prompt`/`steer → {inputId}`, `setModel → {modelSet}`, `abort → {aborted}`, `resumePending → {started}`, `hydrate → {hydrated}`, `delete → {deleted}`, `listSkills → {skills}` (see *Skills*). `connectNode` registers each as a handler and advertises it as a capability.
- **Errors.** A definite rejection throws `NodeRejection` carrying a `NodeError`: `not_found` (no copy of the session on this node), `invalid_request` (bad attachment, unknown model, a hydrate that does not verify), `busy` (a hydrate under an active run), `unavailable` (retryable: an attachment fetch or hydrate pull with no server). Any other exception (a binding mismatch, no pending operation to resume) is sent as `internal`, non-retryable.
- **Test seam.** `nodeRuntimesForTesting(node)` (`has`/`open`/`close`) reaches a node's live runtimes; production code must not import it.

The node serializes provision, hydrate, delete, drops and runtime opening per session (Pi storage has no cross-harness conflict detection). Every command verifies its `binding` against the binding stored at provision/hydrate; a mismatch throws.

## Node hub (server side)

One hub per handler install (`runtimes/node-hub.ts`, `installNodeHub`, closed on uninstall; tests create one with `createServerState()`). It is `state.nodes` (the `NodeHub` interface in `state.ts`) and owns: node links by node ID, the command dispatcher and its `wake()`, the node→server services (reports, events, tool calls, credentials, snapshots/attachments, `runtimes/node-server-handlers.ts`) and submission failure recipients. Interface: `accept(socket)`, `connected(nodeId)`, `wake()`, `send(command)` (immediate controls), `listSkills(nodeId, source)` (see *Skills*), `commandSettled(id)`, `observeSubmission`/`forgetClient`, `start()`/`close()`. Timeouts and the concurrency cap are hub options (`NodeHubOptions`). No live runtime crosses to the server.

`deliverToNode` (`runtimes/node-execution.ts`) resolves the session's source and binding (`runtimes/node-source.ts`: `resolveSessionSource`, `sessionBinding`) and sends over that node's link. With no connected link it defers submitted work (`DeliveryDeferred`) and answers a control `unavailable`. For a session at rest on the server it answers abort `aborted: false` and hydrates the session onto its node before any other command (see *Session relocation*).

**Default source:** a new session is placed on the source its caller names (child and task sessions inherit the caller's), else on its project's **default source: the project's first (lowest-ID) source** (`defaultSource` in `node-store.ts`, `selectCreationSource`). Every project gets a source on the seeded node when created. Selection is policy, not a connectivity check: a session placed on a node that is not connected is created `provisioning` and waits.

**Nodes and sources:** `nodes` identifies execution hosts; `sources` binds a project to a host-local path. Sessions persist `source_id` beside `project_id` (triggers enforce agreement). The node runs a session in its bound source path, not the project's current path.

## Command outbox

Session work reaches nodes through the server's durable `node_command_outbox` ([ADR-010](../adr/010-state-derived-idempotency.md) explains why it needs no receipts).

- **Delivery policy** (`deliveryPolicy()` in the contract): provision, prompt, steer, setModel and hydrate are `submit-work`: stored in the outbox, delivered in order, replayed when the outcome is unknown. Abort and resumePending are `request-now` immediate controls: sent at once, never queued or retried, failing to their caller. Future read-only workspace/git requests should be `request-now` and return `unavailable` when offline.
- **Storage** (`node-command-store.ts`): rows hold a session ID and the command JSON, not a source (the source is resolved at send time). States are `queued`, `dispatching` and `failed`; settled commands are deleted (the outbox is a queue), so no session state is read from it. `createSessionWithProvision` stores a new session and its provision in one transaction; `getNodeCommand` parses stored commands strictly, and one that does not parse fails like a delivery exception (a provision so failed makes its session `provision_failed`).
- **Input:** validated prompt/steer (browser WS, scripting sends, child reports) is stored before acknowledgement, keyed uniquely by `(session_id, command_json.clientId)`. A replay with the same payload returns the prior acknowledgement; a different payload under that key is rejected while pending. Once admitted its command is gone, so `enqueueInput` recognizes a replay from the replica (`replicaInput`: a `reinsInput` with that `reinsId`) and queues nothing. Acknowledgement means stored, not admitted by Pi; later failures surface asynchronously.
- **Dispatcher** (`models/node-command-dispatcher.ts`): scans the outbox in insertion order and runs one **delivery chain per session** that sends that session's commands strictly in order, one at a time, re-resolving the session's source before each. Chains of different sessions run concurrently, at most `MAX_CONCURRENT_SESSIONS` (16) at once; others wait in outbox order. A session's work is attempted only while its source's node is connected (`hub.connected(nodeId)`). Wakes are hints: submissions, a node negotiating, `start()` and a 30 s poll rescan SQLite; a wake arriving while a chain runs is retried when the chain ends. `stop()` (handler uninstall) stops new chains; in-flight deliveries finish and settle.
- **No double delivery:** `claimCommand` is one atomic `UPDATE` moving a row from `queued` to `dispatching` only when no earlier row of its session is `queued` or `dispatching`, so a session never has two commands in flight, even across dispatcher instances during a hot reload.
- **Settlement** (`models/node-command-delivery.ts`): records the result in one transaction with its placement change (`commitPlacement`): an admitted command is deleted; a definite rejection or delivery exception is marked `failed`, notified and deleted (never retried); an unknown outcome (`DeliveryDeferred`: timeout, lost link, send failure, busy, stale epoch, no connected node) returns the row to `queued` and ends that session's chain until the next external wake. `FRAME_TOO_LARGE` and other protocol failures (`-32602`) are terminal.
- **Failure notifications** (`models/node-command-notifications.ts`): an input failure goes only to the currently connected WS client that submitted `(sessionId, clientId)` (the existing error shape; the frontend then refreshes activity); disconnected clients are not notified and there is no replay-to-UI. Provision failures and model-change failures are broadcast to every client with `session_updated`. Scheduling changes notify through `Sessions.notifyScheduling()`.
- **Startup recovery** (`recoverInterruptedDispatches`, once per process when `server-process.ts` opens the database, never on handler install): every interrupted (`dispatching`) command is set back to `queued` and redelivered once its node connects; the count is logged. Its outcome is unknown, and every outbox command replays safely (see *Replay idempotency*), whether or not the node received it. The row keeps its rowid, so it stays ahead of later work for its session, and its session keeps its placement (`provisioning` or `moving`, settled by the replay). Failed commands whose notification the restart lost are deleted (failures are never retried). Running it again inside a live process would requeue another handler's in-flight delivery, putting a second command of that session in flight, hence never on handler install.

Explicit abort and resume are immediate: abort is not ordered behind queued input.

## Session commands on the wire

Every server→node session command crosses the link (`sendNodeCommand` in `node-transport/commands.ts`, client methods on `createServerTransport` in `node-transport/server-peer.ts`, handlers in `connectNode`). Each is a capability checked against the connection's epoch before the node runs anything. All but `session.delete` carry the `binding` (`{sourceId, cwd, createdAt, parentSessionId}`) the server resolves from product rows on every send.

| Method | Params (besides `epoch`, `sessionId`, `binding`) | Result | Delivery | Timeout |
|---|---|---|---|---|
| `session.provision` | `configuration` | `{provisioned: true}` | outbox | 30 s |
| `session.prompt`, `session.steer` | `clientId`, `content`, `sourceSessionId` (nullable) | `{inputId}` | outbox | 120 s |
| `session.setModel` | `provider`, `modelId`, `thinkingLevel?` | `{modelSet: true}` | outbox | 60 s |
| `session.abort` | none | `{aborted}` | immediate | 30 s |
| `session.resumePending` | none | `{started}` | immediate | 60 s |
| `session.hydrate` | `task`, `snapshot` | `{hydrated: true}` | outbox | 10 min |
| `session.delete` | none (no `binding`) | `{deleted: true}` | `node_session_deletions` | 30 s |

`content` is text blocks and image **references** only (at most 64 blocks, text up to 4 Mi characters, allowed image MIME types, `byteSize` ≤ 10 MiB); inline bytes or other block types are `-32602`. `content` and `configuration` use the contract schemas the outbox stores. No outbox command ID crosses the wire: the node keeps no per-command state.

**Outcomes** (`commandOutcome`): a result becomes the `NodeResult`; a node rejection reaches the dispatcher or caller with the node's own code. When the node did not run the command or the outcome is unknown, submitted work throws `DeliveryDeferred` and is requeued; an immediate control returns `{code: "unavailable", retryable: true}`.

**Timeouts** bound admission, not the run (`NODE_COMMAND_TIMEOUTS`, a hub option): prompt/steer may fetch uncached attachments, check out the task branch and build Pi before admission (120 s); setModel and resumePending may open the runtime (60 s); abort waits for the aborted run to go idle (30 s). A timed-out submitted command is requeued and its replay joins or answers the still-running admission.

**Re-entrancy:** a node serving `session.prompt`/`session.steer` calls `attachment.fetch` back over the same link before admission; the peer serves inbound requests while its own call is pending.

**Lost node data:** if the node has no binding for a session it answers `not_found` ("This session's node data is missing. Start a new session.") before Pi admission. For submitted work the server re-hydrates the session onto that node from its replica and resends the command once (see *Lazy trigger*); only if that fails is the input marked failed. Immediate controls return `not_found` to their caller.

### Session configuration (`session.provision`)

The server resolves a session's configuration once, at creation (`createManagedSession`), and freezes it into the stored provision: `configuration: {model: {provider, modelId} | null, thinkingLevel: string | null, task: {title, description, branchName} | null}`. Model: the creation override, else the `default_model` setting; thinking: the override's level, else the default's (`off` is sent as null). The same values are stored on the server session row. A later `default_model` change never reaches an existing session; a session with no resolvable model cannot open until `session.setModel`. The task is a snapshot: later title/description edits are **not** propagated (the branch name is immutable).

On the node (`Node.provision`), provision is idempotent by ordering:

1. A resolved model is looked up in the node's model registry first; an unknown one rejects `invalid_request` (`Model not found: <provider>/<model>`) before anything is stored. The session becomes `provision_failed` with that reason and clients get `{type: "error", sessionId, error: "Session provisioning failed: …"}`.
2. `provisionNodeSession` (`storage.ts`) stores the binding and, on first bind, the task snapshot. An equal binding is a no-op; a different one rejects. The configuration is not part of binding equality.
3. Unless the main lane exists, Pi creates it (`createMainLane` in `runtime/lane.ts`) with the model and thinking level; Pi's lane writes replicate like any commit. No model: no lane.

A replay (lost reply, crash between steps, node restart) runs the steps again and each converges. From then on **Pi's lane is the only durable copy of the model selection** on the node. Pi does not persist the system prompt, so the task snapshot lives with the binding; every runtime open checks out the task branch and renders the system prompt on the node with no server call (see [node-runtime.md](node-runtime.md)).

### Model changes (`session.setModel`)

`Sessions.setModel` (HTTP `PUT /api/sessions/:id/model` and scripting `sessions.setModel`) validates the provider/model against the server catalog (`findPiModel`), then updates the row and enqueues `session.setModel` in one transaction, wakes the hub and broadcasts `session_updated` without waiting. It is submit-work in outbox order: after earlier commands of the session are admitted (a running prompt picks it up from Pi's next LLM turn) and before later ones; the last delivered change wins. Omitting `thinkingLevel` keeps Pi's current level. The node applies it to the open runtime, or opens one (validating the new model, seeding a lane that does not exist, repairing a lane whose model is gone), and persists through Pi's lane. A replay re-applies the same absolute selection. An unknown model fails the command: every client gets `{type: "error", sessionId, error: "Model change failed: …"}` plus `session_updated`. The row keeps the requested model until the next settlement reports Pi's actual selection. A session at rest on the server is hydrated first.

### Skills (`skills.list`)

The skills a session can invoke live in its source checkout on a node, so the server asks the node for them. `skills.list {epoch, sourceId, cwd}` is a negotiated server→node request (a `capability`), not a session command: no `sessionId`, no binding, no outbox. `cwd` is the source's path as the server resolves it (as in a binding; the node has no sources table). The node reads that checkout with the same discovery prompt expansion uses (`ReinsResourceLoader`: `~/.agents` plus the checkout's `.agents/skills`) and answers `{skills: [{name, description}]}`, at most `MAX_LISTED_SKILLS` (1024) entries, names up to 128 and descriptions up to 4096 characters; a checkout that does not exist is `not_found`.

`GET /api/projects/:id/skills` (`routes/skills.ts`, used for the composer's `/name` suggestions) resolves the project's default source and sends `skills.list` to its node through the hub (`state.nodes.listSkills`, `skills` timeout 5 s). It never queues or waits for a node: when the node is not connected, does not answer in time or refuses, it answers `{skills: [], available: false}` (200, logged at debug); otherwise `{skills, available: true}`. The frontend keeps its last known suggestions when `available` is false (`ProjectStore.fetchSkills`/`fetchLists`), so an offline node shows no error.

## Node→server calls

The node reports commits and lifecycle, fetches and uploads attachments, runs Reins tools and reads credentials over the same link. Node→server handlers (`nodeServerHandlers(nodeId, services)`) are resolved per connection from the node ID and fenced by placement (see *Fencing*); the transport imports no product stores.

### Node outbox

Commits, attachment uploads and lifecycle reports share one node table, `session_outbox`, ordered by row ID and drained per session serially (`createOutboxDrain`). A row is deleted only after the server acknowledges it; a failure stops that session's drain until the next commit, report, provision or attach. Attaching a connection replays every session's pending rows. With no connection, rows wait (runs proceed).

- A commit row is inserted inside its Pi commit transaction, and Pi emits `run_start`/`run_end` after that commit, so a settlement is always delivered after the commits it summarizes, and run N's `settled` before run N+1's `started`.
- An `attachment` row is inserted in the same transaction that caches the bytes and creates the reference, before any commit that can contain it, so the server holds the bytes before its replica applies the entry.
- A child session's settlement needs its final reply from an async transcript read: it is inserted at once as not ready, holding it **and every later row of that session**, then completed with `reply` or `replyError`. A new node instance releases rows a crash left unready with `replyError: "The node restarted before the final reply was read"`.

### `session.committed`

`{epoch, sessionId, startSeq, writesJson}` → `{acknowledged: true}`. `writesJson` crosses as a string, byte for byte, because a replay of the last applied batch is compared by the hash of its exact string. The server applies it to its replica by sequence watermark (`applyNodeReplica` in `node-replica.ts`; see *Replay idempotency*). On the server nothing but replica application writes Pi tables. `writesJson` has no size limit (see *Frame caps*).

### Lifecycle reports

`session.started {epoch, sessionId, runId}` and `session.settled {epoch, sessionId, runId, status, error?, metadata: {model, thinkingLevel}, reply, replyError?}` → `{acknowledged: true}` are durable reports that drive server effects: activity `running`/`finished`, runtime model metadata and a child's report to its parent (`runtimes/node-session-events.ts` → `SessionInstance.startedWith()`/`settledWith()`).

- Each report is applied inside one server transaction with its lifecycle watermark (`recordNodeLifecycle`), the activity update, the metadata write and, for a child, the parent's steer inserted into the outbox, so a replayed report can neither re-steer the parent nor re-flip state. Broadcasts and the hub wake happen after commit. Settlements also increment `settlement_count` and record `settlement_next_seq` and the latest status/error for waits.
- A child whose settlement report is enqueued for its parent clears to idle; if the node could not read the reply (`replyError`) or the parent cannot receive it (out of scope, source unavailable), the server logs it and marks the child `finished` with no report.
- Pi re-reports `started` with the same run ID on `run_resume` and in-run compaction; the server treats a `started` for the run that last settled as a replay.
- A run that never settles because its node died mid-run leaves the session `running` (crash recovery is open).

### `session.event`

`{epoch, sessionId, seq, event}` is a JSON-RPC notification carrying live UI deltas only; the server broadcasts `event` to browsers as received (`{type: "event", sessionId, projectId, event}`). Notifications are best effort: an unknown method, invalid params, a failing handler, a stale epoch or an out-of-order seq drops that one notification with a warning and never closes the connection. `seq` is per session and node instance, starts at 1 and counts every emitted event, including ones dropped because no connection was attached; the server drops seqs at or below the last seen on that connection and logs gaps. There is no replay or resync: a lost event only affects live rendering (the transcript comes from `session.committed`). The schema requires every image block in any `content` array to be an attachment reference, so an event carrying inline bytes is dropped at the wire. Run lifecycle is not a session event.

### Attachments

- `attachment.fetch {epoch, sessionId, attachmentId, offset}` → `{attachment: {data, mimeType, byteSize, sha256, filename?, width?, height?} | null}` returns base64 of bytes `[offset, offset + 512 KiB)`. The node loops over offsets, requires consistent metadata and exact chunk lengths, verifies size and sha256, and caches the bytes in `node_attachments` (`node-attachments.ts`) before prompt admission; provider input is then hydrated synchronously from the cache. Opening a runtime does not fetch historical bytes: an uncached reference becomes a provider placeholder. With no connection, a prompt/steer needing an uncached attachment returns `unavailable`.
- `attachment.store {epoch, sessionId, attachmentId, mimeType, sha256, byteSize, filename?, width?, height?, offset, data}` → `{stored: true} | {nextOffset}` uploads node-created image bytes from the node outbox. **The node assigns `attachmentId`** (`att_<uuid>`). If the session already holds that ID with the same content the server answers `{stored: true}` at once (idempotent replay); different content under that ID is rejected as divergence (left pending on the node). Otherwise the server keeps one partial upload per connection and key (at most 8), answers `{nextOffset}` for an out-of-order chunk, verifies the sha256 after the last chunk and stores under exactly the node's ID (the upload MIME allowlist and 10 MiB limit apply; an ID another session holds rejects). Identical bytes under another ID are stored again, never remapped, so every transcript reference resolves as written.
- Limits (`MAX_ATTACHMENT_BYTES` 10 MiB, `ATTACHMENT_IMAGE_MIME_TYPES`) are exported by the contract and used by both sides. Each chunk call has a 30 s timeout.

**Images never cross in events or commits as bytes.** User prompt images are references from the start. Tool-result images are converted where Pi produces them: the node's `after_tool` hook (`runtime/tool-images.ts`) replaces each inline image with a reference before Pi stages the result, reusing a cached attachment of the session with the same sha256/MIME, else caching the bytes under a new ID and appending an upload row in one transaction. Images outside the allowlist, empty or over 10 MiB become a text note (`[Image omitted: …]`), so every queued upload is one the server accepts. A storage-adapter safety net (`referenceInlineImages` in the node's `PiStorageAdapter` `prepare` step) converts any inline image Pi commits without the hook (recovered checkpoints, hooks cut short by abort). Stray inline images in live events (partial tool results) are replaced by `[Image attachment unavailable]` (`sendableEvent` in `node.ts`). Providers still receive bytes: `toProviderMessagesForSession` hydrates references from the node cache. The cache must not be evicted while an upload row names it (nothing evicts it today).

### Agent tools

All tool definitions live on the node: native read/write/edit/bash (`@reins/node/host-tools`) and the Reins tools `create_task`, `search` and `execute` (`@reins/node/reins-tools`). Their names, descriptions, schemas and order are pinned by a snapshot test (`runtime/reins-tools.test.ts`). Each Reins tool forwards one request:

- `script.execute {epoch, sessionId, callId, code}` → `{ok: true, text} | {ok: false, error}`: the server runs the script in its `node:vm` sandbox against the scripting API (`tools/execute.ts`). 5 min timeout.
- `script.search {epoch, sessionId, query}` → `{text, matchCount}` (`tools/search.ts`). 30 s.
- `project.createTask {epoch, sessionId, title, description, branchName?, prompt?}` → `{task, sessionStarting}` (`tools/create-task.ts`). 60 s.
- `script.cancel {epoch, sessionId, callId}` (notification): aborts that script's `AbortSignal` on abort or timeout of `script.execute`; closing the link aborts every in-flight script.

Params name only the calling session; strict schemas reject project/task fields, and `runtimes/node-tool-calls.ts` derives scope from the server's session row. None is retried. Transport failures become tool results: an unknown outcome says the call "may have run"; no connection, busy, invalid params or stale epoch mean it did not run.

### Credentials

**The server is the sole credential holder and the sole OAuth refresher** ([ADR-013](../adr/013-server-holds-credentials.md)). A node needs no credential configuration: every Pi model runtime it builds reads provider credentials through `RemoteCredentialStore` (`packages/node/src/credentials.ts`). Refresh tokens never leave the server.

- `credentials.get {epoch, providerId}` → `{credential}`: the stored credential or `null` (logged out; Pi then falls back to ambient auth, e.g. provider environment variables in the node's environment).
- `credentials.refresh {epoch, providerId}` → `{credential}`: runs Pi's own refresh (`getAuth`) against the server's `DbCredentialStore`, whose `modify` is serialized per provider for the process and persists the rotated credential, so concurrent nodes and the server refresh a login at most once. Failure is `-32000` with `{code: "unavailable", retryable: true}` and "OAuth refresh failed for <provider>; sign in again on the server if this persists". No message carries token material.
- `credentials.list {epoch}` → `{credentials: [{providerId, type}]}`, no secrets.

These are not per session, so any negotiated connection is served; **a remote node must be enrolled and authenticated before they are exposed to it.** Handlers: `runtimes/node-credentials.ts`.

*Wire shape* (`nodeCredential`, strict): `{type: "api_key", key?, env?}` or `{type: "oauth", access, expires, enterpriseUrl?, availableModelIds?, gatewayConfig?}`. `toNodeCredential` copies only `OAUTH_WIRE_FIELDS`, the non-secret fields Pi's providers read at request or catalog time; the schema rejects `refresh` or any other field (`-32603`). On the node an OAuth credential carries `refresh: ""` only because Pi's type requires it.

*Node store:* `read` returns a fresh cached credential or calls `credentials.get` (concurrent reads share one call). `modify(providerId, fn)` is how Pi refreshes and how a login would persist: a function that returns a credential for no prior credential is a login and rejects ("sign in on the server"); otherwise the store returns a fresh cached OAuth credential or calls `credentials.refresh` (shared by concurrent callers). `list` calls the server; `delete` rejects. The cache is memory only, per provider, with no TTL: an API key stays for the life of the connection; an OAuth entry until it enters Pi's 5-minute refresh window (`OAUTH_MIN_VALIDITY_MS`). Every entry is dropped when a connection attaches; logged-out results are not cached. Trade-off: a server-side logout or key change reaches a connected node only on reconnect (or, for OAuth, the next refresh). With no connection, a cached credential still serves `read`; a miss, a token in the refresh window and `list` reject with "Credentials unavailable: no Reins server connection".

## Replay idempotency

There are no receipt tables on either side ([ADR-010](../adr/010-state-derived-idempotency.md)): "already applied" is derived from state, so a replay after a lost acknowledgement or a restart of either side is **acknowledged as success** and applies nothing twice.

**Node → server reports** (`node-replica.ts`, one `node_session_watermarks` row per session):

- *Commits:* the node records a session's batches contiguously from its `harness_next_seq`, so batches never partially overlap. Against the server's `sessions.harness_next_seq`: `startSeq` equal applies the batch and stores its start and the sha256 of its `writesJson`; greater is a **gap** and rejects (the batch stays pending); smaller is a replay and is acknowledged without applying. A replay of the last applied batch is compared by hash (a mismatch is **divergence** and rejects); a batch straddling the watermark rejects as divergence; an empty batch rejects.
- *Lifecycle reports:* the last applied report's `(runId, kind)` and payload hash. A matching report applies nothing and is acknowledged; the same key with a different hash is divergence (rejected, left pending); a `started` for the run that last settled is a replay. Because the node delivers a session's reports in order and deletes each only after acknowledgement, only the last applied report can be replayed.
- *Attachments:* the same content under the same ID is acknowledged; different content rejects.

**Server → node commands** converge on the node's own state:

- **provision:** the binding matches and the lane exists (see *Session configuration*).
- **prompt:** Pi admission is durable (`lane.accept` commits the `reinsInput` keyed by `reinsId` = the command's `clientId`). A replay finds that input and returns it; an in-flight admission of the same input is joined. A recovered operation is driven again only if not already active.
- **steer:** `lane.steer` commits the queued input and Pi moves it from queue to transcript in one commit, so checking the queue first, then entries, cannot miss it. Residual: an abort discards queued steers, so a steer whose reply was lost and which an abort discarded before the replay is re-queued (a resurrection, not a duplicate).
- **setModel:** an absolute selection, re-applied.
- **hydrate:** converges by content (see *Session relocation*).
- **abort, resumePending:** immediate controls, never replayed. Abort with no live runtime returns `{aborted: false}` without opening Pi; resumePending with nothing to resume is an `internal` rejection.

Verified by `__tests__/runtimes/node-execution.test.ts` (replay after a timeout, after Pi admitted an input the server never heard of, and after a server restart interrupted a delivery), `__tests__/server-process.test.ts` (a real server killed mid-delivery) and `packages/node/src/node.test.ts` (replays after a node restart on the same storage).

**Not detected** (acknowledged as already applied): a replayed commit batch older than the last one (only the last batch's hash is kept) and an older lifecycle report (impossible while the node delivers in order).

## Session placement

`sessions.placement_status` is the **single source of truth** for where a session lives ([ADR-011](../adr/011-placement-status-single-source-of-truth.md)), with a failure's reason in `sessions.status_error`. It is written **in the same server transaction as the outbox change that causes it**; nothing derives placement from outbox rows. Values (`PlacementStatus` in `session-store.ts`):

| Status | Meaning | Written by |
|---|---|---|
| `server` | at rest on the server: its server Pi tables are canonical; the server never runs it, and any use hydrates it onto its source's node first | stored rows from before nodes; a failed move of a session at rest |
| `provisioning` | its `session.provision` is queued or being delivered; server tables are the (empty) replica | session creation (`createSessionWithProvision`); every new session starts here |
| `provisioned` | on its node, ready; server tables are its replica | provision or hydrate admitted (`commitPlacement`); a failed move of a node-owned session |
| `provision_failed` | provisioning failed; the session never landed | provision failed |
| `moving` | a move's `session.hydrate` is queued or being delivered; `source_id` is the target | `queueMove` (explicit move, lazy trigger, re-hydration) |

**Failed moves revert.** A move's hydrate command stores, server-side only, the resting state it left: `revertTo: {status: "server" | "provisioned", sourceId}` (the contract schema strips it; it never reaches the node). A failed hydrate returns the session to `revertTo` and records the reason in `status_error`, shown as "Move failed: …". A hydrate interrupted by a server restart is not a failure: it is requeued and replayed (the session stays `moving`). `status_error` is cleared by the next placement change.

**Readers.** `waitUntilProvisioned` (abort, resumePending) returns at once for `server` and `provisioned`, waits for the pending provision/hydrate for `provisioning`/`moving` (rejecting "Execution source unavailable; session provisioning queued" while its node is not connected) and rejects `provision_failed` with "Session provisioning failed: …". Session views expose `placement: {status, error, available, nodeId, nodeName}` (the node it is on, being provisioned on or moving to, or, at rest, the one its next use hydrates it onto; `available`: whether that node is connected). "Open" is reserved for opening a runtime on the node, not for placement.

## Server reads projections only

Server code reads a node's sessions from its own tables, so it works unchanged with the node in another process:

- **Activity** (`models/node-session-activity.ts`): `nodeSessionActivity(row)` is `running` when `activity_state` is `running` (set/cleared by lifecycle reports), `queued` when prompt/steer input for the session is still `queued`/`dispatching` in the outbox, else `idle`. `activeNodeSessionIds()` applies the same rule across sessions. Reading writes nothing. Used by session views (`pendingOperation` only when idle), task deletion (any non-idle session blocks it) and `/api/health` (`activeSessions`, `streaming`). Gap: an admitted input whose `started` has not arrived reads `idle`.
- **Wait** (`SessionInstance.wait`, `api.sessions.wait`): a session at rest on the server returns its transcript result at once. Otherwise it polls projections every 10 ms: it fails at once for `provision_failed`; it tracks every input it sees pending in the outbox and resolves once none is pending, the session is not `running`, and every tracked input the node admitted is covered by a settlement. **Admission is proven by the replica** (settled commands are deleted): an admitted input is a `reinsInput` whose `reinsId` is the command's clientId, either a transcript entry or a steer Pi still holds (`pi.pending.entry`). The node delivers that commit before it answers the command. An entry is covered once the latest settlement was applied after it (`settlement_next_seq` above its seq). A failed input never reaches the replica and expects no run. The result is `transcriptResult` over the replica transcript with the latest settlement's status/error (`completed`/`failed`/`cancelled`, or `idle` with no reply), `timeout` at the deadline; an `AbortSignal` rejects with `AbortError`. Limits: an input admitted before the wait began whose `started` has not arrived reads as settled; an input admitted while an earlier run was active can be covered by that run's settlement.
- **Abort** (`ws.ts`): a session on a node always forwards `session.abort`; the node answers `{aborted: false}` when nothing is live. A session at rest on the server answers "Session not active".

## Session relocation

A session moves between placements through the **server as the hub** ([ADR-008](../adr/008-server-hub-session-relocation.md)). At rest, the server's copy is authoritative; a session on a node has an exact server replica. Every move is a **hydrate** of the server's copy onto the target node: server → node and node A → node B alike. There is **no release** and no node-to-node transfer: the previous owner is told nothing. Code: `models/session-ownership.ts` (state machine, preconditions, fencing, lazy trigger, explicit move), `runtimes/session-relocation.ts` (delivery), `packages/node/src/relocation.ts` and `hydrate` in `node.ts` (node side), snapshot rows and digests in `@reins/pi-sql-storage`.

```
at rest on server (server) ──session.hydrate queued──▶ moving to N ──node acknowledged──▶ owned by N (provisioned)
                                                                  └─failed──▶ back at rest (server) + status_error
owned by A (provisioned, idle) ──re-pointed at B + session.hydrate queued──▶ moving to B ──node acknowledged──▶ owned by B (provisioned)
                                                                  └─failed──▶ back on A (provisioned) + status_error
```

**Queueing a move** is one server transaction: the precondition check, switching `source_id` to the target node's source for the project, queueing `session.hydrate {targetSourceId, revertTo}` and marking the session `moving`. From that commit the previous owner is fenced. The session becomes `provisioned` on the target in the transaction that settles the command. Moves are submitted work in outbox order, so input submitted during a move waits behind it.

**Preconditions.** A node-owned session moves only when idle **on the server**: not `running`, no pending input and no other queued/dispatching command; otherwise 409. Because `session.settled` is delivered after the run's commits, a session the server sees as idle has a replica holding everything through its last run. Moving to the node it is already on (or moving to) queues nothing; moving elsewhere while a move is under way conflicts.

**Accepted loss.** Commits the old owner made **outside a run** (e.g. the lane write of a `session.setModel`) and had not delivered when the session moved are lost: the new owner hydrates the server's copy without them, and the old owner's late delivery is refused.

**Hydrate protocol (pull, chunked).** The server sends `session.hydrate {binding, task, snapshot}`, all resolved at delivery time: the binding for the target source, the task snapshot from the task row and `snapshot = {harnessNextSeq, rowCounts: {entries, values, lists, usage}, digest}` from the server's copy. The node pulls:

- `session.snapshot {epoch, sessionId, fromSeq}` → `{summary, rows, nextSeq}` (read-only): rows with seq ≥ `fromSeq` from `session_messages` (parents by harness ID), `pi_values`, `pi_lists` and `pi_usage`, in (seq, table, key) order, at most 500 rows and about 4 MiB per page (never splitting a seq), `nextSeq` null after the last page. History that is not canonical AgentHarness storage (an entry without a harness ID) is refused.
- `attachment.fetch` for every attachment referenced in the rows. Inline images in history written before nodes stay inline; an attachment the server no longer holds is skipped (providers get the missing-image placeholder); a checksum or metadata mismatch rejects.

Every page's summary must equal the command's ("changed during hydration" otherwise). In **one node transaction** the node binds the session, writes every row verbatim (`harness_next_seq` copied), caches the attachments and recomputes the summary (`summarizePiSnapshot`, a sha256 over every row, computed the same way on both sides); any mismatch rolls back and rejects `invalid_request`. Pi is not involved: rows are copied, not rebuilt.

**Replace on hydrate.** A node that already holds a different copy (moving back to a previous owner) closes the session's idle runtime (an active run refuses with `busy`), drops everything it holds for the session (`dropNodeSession`: binding, Pi rows, outbox, attachment cache) and then pulls. The old copy is dropped **before** the pull, so a failed hydrate leaves no stale copy: later commands answer `not_found` and the server re-hydrates.

**Idempotency.** A node that already holds an **identical** copy (binding and summary) answers at once without pulling. A node that restarts or loses its connection mid-pull has stored nothing and starts over on the replay. A retryable rejection (server unreachable mid-pull) or unknown outcome requeues the move; other rejections fail it, broadcasting `Session move failed: …` and `session_updated`, and the session reverts. A failed move does not block commands.

**Continuity.** The node's copy continues from the copied `harness_next_seq`, so its next commit applies to the replica directly; watermarks belong to the session, not the node, and carry over. Model and thinking level come from the copied Pi lane; the task snapshot from the task row at hydration. A copy with no Pi lane (a session at rest that never ran) gets the row's model as a queued `session.setModel` behind the hydrate.

**Lazy trigger.** The next use of a session at rest on the server (`enqueueSessionInput`, `Sessions.setModel`, resumePending) queues `session.hydrate` onto its source's node **ahead** of the work in the same transaction, unless one is pending (`queueHydrationForUse`). Every hydration is an outbox command. Work that still reaches a session at rest (behind a failed move) fails with the move's reason; abort answers `aborted: false`. Viewing history never moves a session. **Re-hydration:** when the node of a `provisioned` session answers `not_found` to prompt, steer or setModel, the settling transaction queues a hydrate of the replica onto that node ahead of the work, marks the work `rehydrated` (server-side only) and requeues it (`queueRehydration`); work already `rehydrated` settles with its `not_found`.

**Fencing.** Node→server writes (`session.committed`, `session.started`/`settled`, `session.event`, `attachment.store`, `script.*`, `project.createTask`) are accepted only for a session placed on the sending node: `placement_status` neither `server` nor `moving`, and the session's source on that node (`nodeOwnsSession`). Otherwise they are refused with `-32000` and `NodeError` `{code: "not_owner", message: "Node session unavailable: <id>", retryable: false}` (events are dropped). Reads (`session.snapshot`, `attachment.fetch`) are allowed whenever the session's source is on the calling node, at rest or moving included (`nodeMayReadSession`), which is how a hydrating node pulls.

**`not_owner` on the node.** When an outbox delivery is refused with `not_owner`, the node stops that drain and, serialized with the session's hydrate and runtime opening, drops the session (aborts and closes its runtime, deletes its pending rows and local copy). Until it is hydrated there again, commands answer `not_found`. The drop is keyed to the copy the refused report came from, so a late refusal never drops a copy hydrated after it. Agent tool calls refused with `not_owner` just fail as tool results.

**Session deletion.** Deleting a session row on the server (directly, with its task or with its project) records, by trigger, one `node_session_deletions` row per node (previous owners are not tracked, so every node is told). The hub sends each connected node `session.delete {sessionId}` for its rows, one at a time, clearing each once acknowledged; a pass runs when a node negotiates and on every `hub.wake()`, and stops at the first failure. The node drops everything it holds for the session (idempotent). Removing a node deletes its rows. A late report for a deleted session is refused with `not_owner`.

**Explicit move.** `POST /api/sessions/:sessionId/move {nodeId}` (required; there is no release to the server) queues the move and returns the placement without waiting; 409 for a busy session, a move elsewhere under way or a node with no source for the project; 404 for an unknown session. `GET /api/sessions/:sessionId/move-targets` lists every node as `{nodeId, name, connected, eligible, reason?}`, eligible first, each group by name; `reason` is `"current"` or `"no_source"`. The move and its settlement each broadcast `session_updated`.

**Limits.** The node holds a hydrating session's rows and attachments in memory until its single write transaction; the server recomputes the summary for every snapshot page (quadratic in pages for very large sessions). Sessions with active runs are never moved. Ownership is per node, not per copy: if a session moves A → B → A while A was offline, A's undelivered reports from its first stay meet the replica's own checks after the move back (a gap or divergence stays pending until the hydrate replaces A's copy). Cross-node moves between two real node processes are untested (tests route to a second loopback node).

## Node storage and migrations

The node's SQLite (`~/.reins/node/storage.db`, independent of the server's `REINS_DATA_DIR`) holds session bindings with their task snapshots, canonical Pi tables, the ordered `session_outbox` and the `node_attachments` cache. `openNodeDb` runs node-owned, append-only migrations with their own ledger; they never touch product SQLite, and an unrecognized database fails closed. See [node-migrations.md](node-migrations.md). Back up node storage with the server database: discarding it loses nothing the server replica holds, but undelivered commits and uploads are lost, and its sessions are re-hydrated from the replica on next use.
