# ADR-029: Sessions on the Server; Nodes Host Tools

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends:** [ADR-013](013-server-holds-credentials.md) (nodes get no credentials), [ADR-015](015-server-canonical-storage-stateless-node.md) (storage no longer crosses to nodes), [ADR-019](019-server-generated-system-prompt-and-session-kinds.md) (the environment is no longer all machine-local), [ADR-020](020-reloadable-node-hub.md)/[ADR-021](021-explicit-node-reload.md) (running sessions are kept across handler reloads; what pauses and resumes them)
- **Supersedes:** the durable command outbox ([ADR-010](010-state-derived-idempotency.md) *Server → node commands*)

## Context

Every session runs on a node today: the node's Pi runtime (AgentHarness 0.85) reads and commits the session's storage on the server over the link (ADR-015), reads credentials over it (ADR-013) and builds its model runtime from its own machine's Pi configuration. A Mac paired as a remote node could not run Opus 5.5: the model is only in the server's model store, which only the server refreshes from the network (the bundle runs with `PI_OFFLINE=1`), and the server's `models.json` points `anthropic` at a proxy on `127.0.0.1`, which on the Mac is the Mac. Both were hidden on the server's machine, where the server and the local node read the same `~/.pi/agent`.

Custom models and endpoints will keep being set up on the server. Options considered (node-architecture plan, *Sessions on the server; nodes host tools*):

1. **Loop and inference on the node** (until now), with `models.json` and the model store copied to every node and endpoints rewritten. Rejected: every new custom model is another rewrite.
2. **The server as model gateway, the loop on the node.** A credential-adding HTTP proxy breaks OAuth logins, because Pi builds the request from the credential (Claude Code tokens, Codex, Copilot). Relaying Pi's `Models` interface works, but each turn reads its context from the server's storage and sends it straight back to the server's gateway. Rejected.
3. **The loop on the server side; nodes host tools.** Chosen.

Pi points the same way: Pi 1.x replaces AgentHarness with `pi-durable`, where one process owns a session's storage and tools reach files and processes only through a per-call `ExecutionEnv` built for remote hosts. pi-durable is experimental, so Reins stays on 0.85 and adopts its shape: the later switch then happens in the session layer and nodes do not change.

## Decision

**Running sessions live on the server side.** AgentHarness, its storage on the server's database (`PiStorageAdapter`) and the server's model runtime (`pi/factory.ts`: catalog, `models.json`, model store, credentials). Credentials and model configuration never leave the server's machine.

**Running sessions are kept across handler reloads** the way Reins kept them before the node split: a map of live runtimes in state the server process owns, which handler code fills and an idle timer empties. It is not a node: no `nodes` row, no source, no link. Rejected: the node's runtime in the server process over an in-memory link (the plan's option (a)), whose main reuse was outbox replay (gone, below) and which would keep what this decision deletes (storage, credentials and session calls serialized over a link, live-session lists and lost-run recovery at every reload) and make the layer a pseudo-node in the hub; and a separate package kept external to dev bundles (option (b) as first drafted), which would make the agent loop restart-only for no present need.

- **The code is backend code.** The session runtime moves from `packages/node` into the backend (`sessions/`: the AgentHarness wrapper, pause gate, tool images, Reins tools, resources and environment prompt, attachment cache, event shaping) beside `PiStorageAdapter`. It hot reloads like the rest of the server.
- **The process owns the map** (`server-process.ts`): live runtimes by session ID with their last activity, and the openings in progress, handed to every handler load as `clients` is. A load opens a runtime with its own code and puts it there; a runtime keeps the code it was built with. On a reload idle runtimes are closed at once and running ones once they go idle, so the next prompt opens on the new code; otherwise a runtime idle for 3 minutes, not streaming, is closed. Closing holds nothing back: everything is in storage.
- **The process owns the database connection** too, opened by the process (with its pragmas) and handed to each load, which runs its migrations on it when it starts, so a new migration still applies on the next reload, and no longer closes it (amending ADR-020, whose reason for a database per load, outbox recovery against the previous dispatcher, goes with the outbox). A runtime built by one load keeps working on the next.
- **What a runtime reaches of a load** (the hub to reach its source's node, run lifecycle `runStarted`/`runSettled`, the Reins tools, the credential store with its refresh lock) it resolves at each call through the process-owned state, from the load serving now, never captured from the load that built it. A call during the reload gap waits for the next load (bounded, as node calls wait for a connection today); a script cut off by a load's `stop` comes back "may have run", as now. A runtime still running old code calls the new load through this narrow surface; a change that breaks it needs a restart.
- **Recovery:** at process start the server resumes every session it sees running (open the runtime, resume Pi's pending operation), settling it as interrupted when nothing is pending, the resume fails or its resume budget (ADR-021's limit, now process-owned, so a reload no longer resets it) is spent. After a handler reload nothing needs recovering: runtimes never left memory. On SIGTERM the process pauses runs at their pause points (bounded, then forced) and suspends them, so a restart pauses and resumes runs as a node reload does today.

**Submitted work goes straight to the session layer; the outbox goes.** With the loop on the server, Pi's own durable admission is the record of submitted work: a prompt is a `reinsInput` admitted under its `reinsId` (the browser's `clientId`), a steer is queued on the lane, a model change is a lane write. Submission acknowledges once Pi has committed it. `node_command_outbox`, its dispatcher, routing and recovery are deleted, with the browser's submission failure tracking (a failure is now the submission's own answer).

- **Order:** the server runs one chain per session, entered synchronously when a call arrives, so a session's submissions apply in arrival order. A repeat under the same `clientId` converges on the admitted input and is acknowledged again.
- **Model changes** are validated against the server's catalog and written through the lane; a failure is the request's error. **Abort, resume and close** act on the live runtime and no longer need the node.
- **A child's report to its parent** can no longer share a transaction with the child's settlement: the steer goes through the parent's Pi runtime, which commits on its own. It is two ordered steps: steer the parent under a key derived from the child and its settlement (`child-report:<childId>:<n>`), then commit the child's settlement. A crash between them leaves the child running; recovery settles it and repeats the steer under the same key, which Pi recognises as a replay.
- **A node that is offline** does not hold up admission or model requests. What needs the checkout waits for its node: the task branch checkout and the checkout's environment are prepared at the run's first assistant request (a clean pause point, abortable; Pi 0.85 takes the system prompt as an async function), and tool calls wait. Slash expansion of a skill only the checkout has fails the submission while the node is offline. **A removed node** (ADR-028): new work is still refused; removing it aborts the runs on its sources, and tool calls waiting for it fail.

**Every node is a tool and file host**, the server machine's included, none special. It serves the operations of Pi's tools as a remote `ExecutionEnv` on a source's checkout (the binding's `cwd`): `readTextFile`, `readBinaryFile`, `writeFile`, `exec`, `fileInfo`, `exists`, `absolutePath`, `canonicalPath`, `cleanup`, and as now `process.run`/`fs.*` for git and the UI. New node methods: `env.fs` (one table of file operations), `env.exec`/`env.execAttach`/`env.execKill`, and `checkout.environment`; the hello carries the node's docs directory. bash's environment (`PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`) goes with each `exec`, and its output streams back. `read`'s images arrive as bytes and become attachments on the server. Nodes run no Pi, hold no session state and get no credentials, events or lifecycle reports. The server machine's node still links over the Unix socket without pairing.

**Tool calls survive a dropped link.** Node links stay per handler load (ADR-020), so every reload drops every link. The remote environment takes the current load's hub, waits for the node, and calls it; a drop or a closed hub sends it round again on the next. Short calls are safe to repeat and are sent again. An `exec` has an ID: the node keeps the process and the tail of its output for a grace period after a drop (then kills it), and the server picks it up on the new link by ID and output offset and keeps feeding the same tool call. Aborting the call kills it. A node that restarted does not know the ID: the call comes back "outcome unknown", as today. A node reload drains running execs instead of runs.

**The environment comes from the server plus the checkout.** User skills and `~/.agents/AGENTS.md` from the server's `~/.agents`; the checkout's context files (AGENTS.md in the checkout and its ancestors) and skills (`.agents/skills`) from the source's node, with content, in one call. A node's own `~/.agents` is no longer seen. The REINS docs path in the environment prompt is the node's (the model reads it with `read`, which runs there), reported by the node. Slash expansion and `GET /api/projects/:id/skills` use the same merge; `skills.list` goes. The task branch checkout runs through the server's `Git` over `process.run`.

**No compatibility path.** Only the local node has to keep working, and it runs from source. There is no switchover by node capability: the server and its nodes move together, as for any protocol version change, and a remote node updates itself on connect (ADR-025). Session data does not migrate: transcripts, lanes and model selections are the same Pi 0.85 storage on the server. Runs in flight at the switch are resumed on the server side like any lost run (ADR-021).

**Removed from nodes and the protocol:** `session.*` commands, `storage.*` (slicing included), `credentials.*`, `session.event`, attachment fetch and store, lifecycle reports, `script.*` and `project.createTask` over the link, `skills.list`, the hello's `liveSessions`, and Pi in the node bundle with its workarounds (`PI_OFFLINE`, `PI_PACKAGE_DIR`, `registerBundledPiModules`).

## Consequences

- A model set up on the server works for sessions on every node; nodes need no Pi configuration or credentials.
- The server process does inference and runs the agent loop for every session. Its memory grows with the number of open sessions, bounded by the 3-minute idle eviction.
- The agent loop hot reloads with the rest of the server: new runtimes get new code, a running one keeps its old code until it goes idle. A handler reload no longer pauses or resumes runs; it costs a reconnect of each node, which tool calls ride through. Only an incompatible change to what a runtime calls on a load, or to the process-owned state, needs a restart.
- A crash in the agent loop takes the HTTP server with it; they are one process.
- Acknowledging a submission now waits for Pi's admission, which may first open the session's runtime.
- The guarantee that a child's report and its settlement commit together is replaced by ordering and a replay key.
- A node restart or update (ADR-021, ADR-025) now interrupts only tool calls in flight on it, not runs: the session layer's calls wait for it and an `exec` it lost comes back "outcome unknown".
- Moving to pi-durable later changes the server's session code only.
- ADR-010's server→node replay rules no longer apply: there are no server→node commands. Its node→server rules go with storage and reports crossing the link.

## Later

- A package or process of its own for the session code (not a node), if keeping runtimes on old code across reloads proves costly.
- pi-durable once stable, in the server's session code only.
- A model only one node can reach: a node could offer an endpoint back through the server.
