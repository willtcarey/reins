# ADR-029: Sessions on the Server; Nodes Host Tools

- **Status:** Accepted
- **Date:** 2026-10-11 (revised through 2026-10-18)
- **Amends:** [ADR-013](013-server-holds-credentials.md) (nodes get no credentials), [ADR-015](015-server-canonical-storage-stateless-node.md) (storage no longer crosses to nodes), [ADR-018](018-process-run-and-fs-methods.md) (the `fs.*` methods serve everything, with Pi's semantics, unconfined on the node), [ADR-019](019-server-generated-system-prompt-and-session-kinds.md) (the server builds the whole prompt), [ADR-020](020-reloadable-node-hub.md)/[ADR-021](021-explicit-node-reload.md) (running sessions are kept across reloads of the app; what pauses and resumes them)
- **Supersedes:** the durable command outbox ([ADR-010](010-state-derived-idempotency.md) *Server → node commands*)

## Context

Every session ran on a node: the node's Pi runtime (AgentHarness 0.85) read and committed the session's storage on the server over the link (ADR-015), read credentials over it (ADR-013) and built its model runtime from its own machine's Pi configuration. A Mac paired as a remote node could not run Opus 5.5: the model was only in the server's model store, which only the server refreshes from the network, and the server's `models.json` points `anthropic` at a proxy on `127.0.0.1`, which on the Mac is the Mac. Both were hidden on the server's machine, where the server and the local node read the same `~/.pi/agent`. Custom models and endpoints will keep being set up on the server.

Reins also kept its own copy of each run on the `sessions` row (`run_id`, `run_started_at`, a stored `running`, settlement counters), dating from when the server learned of runs only through a node's lifecycle reports. Once Pi's storage and the runtime driving it are in one process, that copy only drifts: sessions were found with Pi's result `completed` and the row `failed: "The run was interrupted"` (a settlement lost when the process exited mid-apply, which a child then reported to its parent as a failure).

Pi points the same way: Pi 1.x replaces AgentHarness with `pi-durable`, where one process owns a session's storage and tools reach files and processes only through a per-call `ExecutionEnv` built for remote hosts. pi-durable is experimental, so Reins stays on 0.85 and adopts its shape.

## Decision

**Running sessions live on the server.** AgentHarness, its storage on the server's database (`PiStorageAdapter`) and the server's model runtime (`pi/factory.ts`: catalog, `models.json`, model store, credentials). Credentials and model configuration never leave the server's machine. The session code is backend code (`session-runtime/`) and hot reloads with the rest of the server.

**Running sessions are kept across reloads** in state the server process owns (`ServerProcess`, passed whole to every app; the app is the server's swappable code: routes, ws handlers, the node hub, models).

- **The process owns the runtime map** (live runtimes by session ID, openings in progress), the **database connection** (each app runs its migrations on it at start), the browser connections and the credential store's per-provider refresh lock. An app opens a runtime with its own code; a runtime keeps the code it was built with. On a reload idle runtimes close at once and running ones once idle; otherwise a runtime idle 3 minutes, not streaming, is closed. Closing holds nothing back.
- **A runtime keeps the process, never the app.** What it needs of an app (the hub, the Reins tools: `App`) it reads at each call from `ServerProcess.app`, undefined during a reload's gap: a node call then waits as for an offline node, and a Reins tool call is not run. It applies its own run ends to the database and broadcast, and steers a child's report into its parent through the process's open sessions.
- **Process-owned code imports no app code** (`process-owned.json`, held by the `reins/process-owned-imports` lint rule); changing it needs a process restart.

**Submitted work goes straight to the runtime; the outbox goes.** Pi's durable admission is the record: a prompt is a `reinsInput` admitted under its `reinsId` (the browser's `clientId`), a steer is queued on the lane, a model change is a lane write; submission acknowledges once Pi has committed it. One chain per session keeps arrival order; a repeat converges on the admitted input. Abort, resume and close act on the live runtime. A node that is offline holds up only what needs the checkout: the task branch and environment are prepared at the run's first assistant request (a pause point, abortable), and tool calls wait. A removed node (ADR-028) refuses new work; removing it aborts the runs on its sources, and tool calls waiting for it fail.

**Run state comes from Pi and the live runtime.** Running is the process's live state: a session runs while it has a submission in progress, a live runtime that `isBusy()` (streaming, or a run's end being applied), or an opening of a session Pi has an operation in progress for. The session store derives `activity_state` from that, and the runtime announces its busy edges and offers `whenIdle()`. The row keeps only what Pi cannot hold: the unread flag, the automatic resume budget (`auto_resumes`; ADR-021's limit, on the row so it survives the crashes it counts) and the last run end Reins applied (`settlement_json`: Pi's operation ID, `source` `pi` for Pi's `run_end` or `reins` for an end Pi cannot express, a give-up or a storage fault, `status`, `error?`).

- **A child's report to its parent** is two ordered steps, steer the parent then record the child's end, under a key derived from durable state (`child-report:<childId>:<operationId>`, `:interrupted` for a give-up), so a replay after a crash between them is one Pi recognises.
- **Recovery** at process start resumes every session whose main lane has a current operation Reins has not given up on, within the resume budget, and gives up (a `reins` end) when the budget is spent or the resume fails. On SIGTERM the process pauses runs at their pause points and suspends them. After a reload nothing needs recovering.
- **Waits** rest on the live state and the caller's inputs still queued in Pi; their outcome is the recorded end when it names Pi's newest run, else Pi's newest run result.
- **Reads of Pi's storage go through one module** (`pi/run-state.ts`), over Pi's exported address helpers and types; pi-durable replaces it.

**Every node is a tool and file host**, the server machine's included. It runs no Pi, holds no session state and gets no credentials, events or reports.

- **One family of file methods, `fs.*`, with Pi's semantics** (`fs.info`, `fs.list`, `fs.read`, `fs.write`, `fs.absolutePath`, `fs.canonicalPath`): what Pi's `NodeExecutionEnv` does on the node for the call's `cwd` (`~` is the node's home), answering Pi's `Result`. They serve the agent's tools (the server's `RemoteExecutionEnv`), discovery and the file browser alike. The node confines nothing; the server confines what a browser names to the checkout before calling.
- **Pi's shell commands are `pi.exec`, `pi.execAttach` and `pi.execKill`.** Git keeps `process.run` (raw argv, all of stdout as bytes).
- **The node says where its REINS docs are in its hello.**

**Tool calls survive a dropped link.** Links are per app (ADR-020), so a reload drops them, as do restarts and network failures. The remote environment waits for the node and sends short calls again on the next link. A command has an ID: the node keeps it and the tail of its output for a grace period after a drop, and the server picks it up by ID and offset. bash commits the ID as a memo of its tool call before sending the command, so when Pi reruns a call cut off by a server restart it only attaches; a command the node no longer has comes back "outcome unknown". A node reload drains its running commands.

**The environment comes from the node.** The node's `~/.agents` (its `AGENTS.md` and user skills, found with `fs.absolutePath("~/.agents")`) merged with the checkout's (`AGENTS.md` in the checkout and its ancestors, `.agents/skills`): `~/.agents` first, a checkout skill of the same name hidden. The server discovers both with Pi's own `loadSkills` over a strict remote environment, where a call the node did not answer fails the discovery rather than passing for an empty one. Every listed path is on the node, where `read` runs. The system prompt, slash expansion and `GET /api/projects/:id/skills` use the same discovery. The server's own `~/.agents` is not used; skills meant for every node will come from Reins.

**No compatibility path.** The server and its nodes move together, as for any protocol change; a remote node updates itself on connect (ADR-025). Session data does not migrate: it is the same Pi 0.85 storage. Removed from nodes and the protocol: `session.*`, `storage.*`, `credentials.*`, `session.event`, attachments, lifecycle reports, `script.*`, `skills.list`, `checkout.environment`, `env.fs`, and Pi in the node bundle.

## Options considered

- **Loop and inference on the node**, with `models.json` and the model store copied to every node and endpoints rewritten. Rejected: every new custom model is another rewrite.
- **The server as model gateway, the loop on the node.** A credential-adding HTTP proxy breaks OAuth logins (Pi builds the request from the credential). Relaying Pi's `Models` interface works, but each turn reads its context from the server's storage and sends it straight back. Rejected.
- **The node's runtime in the server process over an in-memory link.** Rejected: it keeps what this deletes (storage, credentials and session calls serialized over a link, lost-run recovery at every reload) and makes the session layer a pseudo-node.
- **A separate package for the session code, kept out of dev bundles.** Rejected for now: the agent loop would become restart-only for no present need.
- **Node-side discovery of the checkout's environment** (`checkout.environment`). Rejected: a second copy of Pi's discovery on the node, and every change to the rules a protocol change.
- **Merging `process.run` into the shell commands.** Not now: Pi's capture is bounded, merged and text; git needs all of stdout, separate, as bytes.
- **The server's `~/.agents` for every session** (listed by server paths, `read` of them served on the server, or their content sent with the environment). Rejected: it carries one machine's skills to another and special-cases `read`; shared skills belong to Reins.

## Consequences

- A model set up on the server works for sessions on every node; nodes need no Pi configuration or credentials. A remote node's sessions see that machine's `~/.agents`, not the server's.
- The server process does inference and runs every session's loop; memory grows with open sessions, bounded by idle eviction. A crash in the loop takes the HTTP server with it.
- The loop hot reloads: new runtimes get new code, a running one keeps its old code until idle. A reload costs each node a reconnect, which tool calls ride through.
- A node restart or update interrupts only tool calls in flight on it, not runs.
- Acknowledging a submission waits for Pi's admission, which may first open the runtime.
- A child's report and its parent's steer no longer commit together; ordering and a replay key replace that.
- The run-state drift goes: no stale `running` row, no false failure reported to a parent. But a run Pi ended whose end an exit cut off is not seen by recovery, so its effects (unread flag, a child's report) are lost.
- Discovering skills takes several round trips through the node (Pi's `loadSkills` one call at a time): free locally, latency on a remote link at a run's first request, slash expansion (bounded 10 s) and suggestions (5 s). With the node offline a session has no skills to suggest or expand.
- Reins reads Pi 0.85's storage format, confined to `pi/run-state.ts`.

## Later

- A package or process of its own for the session code, if keeping runtimes on old code across reloads proves costly.
- pi-durable once stable, in the server's session code only.
- A model only one node can reach: a node could offer an endpoint back through the server.
- Catching up a run end an exit cut off, and starting steers left in an idle lane's inbox by a crash.
