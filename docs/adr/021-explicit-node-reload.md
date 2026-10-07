# ADR-021: Explicit Node Reload and Automatic Resume

- **Status:** Accepted
- **Date:** 2026-10-06
- **Amends:** [ADR-020](020-reloadable-node-hub.md) (the node no longer only runs new code after a manual restart) and [ADR-015](015-server-canonical-storage-stateless-node.md) *crash recovery* (a lost run is resumed, not settled as failed)

## Context

Since [ADR-020](020-reloadable-node-hub.md) every server source hot reloads, but the node does not: a node edit takes effect only when the node restarts. Until now a restart cost every active run. SIGTERM aborted them, a crash cut them off, and when the node reconnected the server settled every run it still saw running as failed ("interrupted"). The run then stayed pending until someone resumed it explicitly, and a child's interruption reached its parent as a failure. Reins is developed with Reins, so the session editing node code usually runs on the node it is editing.

The node holds nothing durable ([ADR-015](015-server-canonical-storage-stateless-node.md)): a runtime is a cache over the session's storage on the server, and Pi can resume an operation from that storage. What a restart costs depends on where the run is cut off (checked against `pi-agent-core` 0.85.1):

- **During an LLM request** (`assistant.effect_pending`): Pi records the saved partial output as an interrupted message and requests again, which uses one retry attempt. The partial output is thrown away and the request is paid for again.
- **During a tool call** (`effect_pending`): Pi reruns only tools marked `replay: "safe"`, and no Reins tool is. The model gets the last saved output plus "outcome unknown", and the bash process tree is killed. `script.execute` and `project.createTask` keep running on the server, so the model may repeat them.
- **At the assistant step's `before_request`** (the run is in `assistant.ready` or `assistant.retry_wait`, before the request is recorded) **or at `before_tool`** (the call is still `planned`): nothing has started. Pi resumes into a fresh request or runs the tool normally. No retry attempt is used and no outcome is unknown. A compaction summary's `before_request` is not such a point: it runs inside an effect Pi has already recorded.

Hooks get the run's abort signal. Pi catches an error thrown by a hook (a throwing `before_tool` blocks its tool), so a hook that waits must return when its signal aborts, never throw.

Alternatives considered:

- **Reload on every file change.** Every save interrupts every running session, including the next request of the agent that saved. Rejected.
- **Reload when every session has settled.** This is a wait across the whole node: orchestrator parents stay running while their children work, so the node is rarely idle. The node also cannot turn work away while it waits, because the dispatcher treats any node rejection as the input's terminal failure. Rejected.
- **Two code generations in one process,** handing each session to the new code when it goes idle. Nothing in flight is lost, but it needs a permanent process-owned layer in the node: the link, shared event seqs, a shared report queue and routing per session. That is the kind of machinery ADR-020 just deleted from the server. Rejected.
- **Resume only runs paused for a reload** (the node or the supervisor telling the server which exits were reloads). This keeps crashes as they were, but it needs a protocol field and state carried across the restart, and it leaves crashes and node upgrades without recovery. Rejected in favour of resuming every lost run, with a limit against crash loops.

## Decision

**The server resumes every run a node lost.** When a node negotiates, every session on that node the server still sees `running` and the hello does not list as live is resumed: the server calls `session.resumePending` for it directly, the same call `POST /api/sessions/:id/resume` makes. The session stays `running` throughout. The server's view is accurate because the node delivers a run's lifecycle reports before it lets the run go. The server settles the run as interrupted, as before, in three cases:

- the resume call fails;
- the node answers `{started: false}`: the run has nothing pending (Pi already ended it);
- the session has used up its automatic resumes: 3 within 10 minutes (`AUTO_RESUME_LIMIT`, counted per session in the hub's memory). This stops a run that crashes its node from crashing it forever, and every session on that node uses up its budget, since the server cannot tell which one caused the crash.

Resuming is made replay-safe: queued input is sent as soon as the hello is answered and can join the paused operation before the resume call arrives. The node answers `{started: true}` while the operation is being driven, whoever started it, and `{started: false}` only when there is nothing to resume.

**A node pauses runs at clean points, never aborts them, when it goes away on purpose.** `Node.pause({timeoutMs, force})` holds every run at its next assistant `before_request` or `before_tool`. New prompts and steers are still admitted (admission only commits), and their runs are held at their first request. An abort releases a held run as usual. The pause resolves once every runtime is quiet: no admission and no tool call in flight, every active run held, and every lifecycle report delivered. At the timeout it resolves anyway with `force`; without `force` it releases the runs and reports which sessions blocked it.

**SIGTERM pauses everything, and stopping Reins means "pause everything".** On SIGTERM the node pauses with `force` (bounded at 3 s), then closes its connection and closes every runtime *without aborting*. Anything still in flight is cut off and recovered by Pi as described above. The next node to connect resumes the runs. Stopping a runaway agent is done with abort, not by stopping Reins.

**Reloading is explicit.** `POST /api/nodes/:nodeId/reload {force?}`, the scripting call `api.nodes.reload(nodeId?, force?)` (the calling session's node by default) and `bun run node:reload` (a CLI over the endpoint) send the node `node.reload {epoch, force?}`. The node:

1. refuses when it is not supervised (nothing would restart it), or when its new code does not build (`Bun.build` of its entrypoint), with the build error;
2. otherwise answers `{scheduled: true}` at once. The answer never waits for the reload: the caller's own tool call is one of the things the reload waits for;
3. pauses (bounded at 60 s, `RELOAD_DRAIN_TIMEOUT_MS`). If the pause times out without `force`, the reload is cancelled and the node logs the sessions that blocked it;
4. exits with `RELOAD_EXIT_CODE` (75). The supervisor restarts a node that exits with that code at once, without crash backoff.

The new node connects, and the server resumes the held runs from where they were held. The agent that asked sees its call return; its next request is the first thing to run on the new code.

The protocol moves to version 8 (`node.reload`; `session.resumePending` answers `{started: false}` instead of failing).

## Consequences

- A run interrupted by a crash, a SIGTERM, a reload or a dropped link continues on its own. The interrupted banner and manual resume remain for runs past the limit and resumes that fail.
- A crash cuts runs off wherever they are: a request in flight is paid for again, and a tool in flight comes back as "outcome unknown". A reload or a SIGTERM avoids that unless a call is still in flight at its bound.
- A long tool call (a 20-minute test run) holds up a reload for every session until it finishes or the reload times out. Cancelling at the timeout is the default, because cutting the tool off is the worse outcome.
- Stopping Reins no longer stops agents: they continue when it starts again. Abort them first to stop them.
- Calls not tied to a session (`process.run` streams, `fs.*`) that are in flight when the node exits fail with `unavailable`, as on any dropped link.
- The node keeps no state across a restart: the server knows what was running.
- Nothing new is shown in the UI: a paused session reads as `running`, as if its model were slow. Watch how long reloads take, and how often a new node fails to start, before adding a node status.
- Protocol and process-owner edits still need the server and node restarted together.
- Remote node upgrades get resume after a build change from the same path ([node-architecture.md](../plans/node-architecture.md) *Code delivery*).
- See [hot-reload.md](../dev/hot-reload.md) and node-contract.md *Crash recovery*.
