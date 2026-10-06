# Explicit Node Reload and Automatic Resume

Status: **done.** Decision: [ADR-021](../adr/021-explicit-node-reload.md).

Let a CLI or an agent's `execute` script reload the node: every run is held at its next clean point (the assistant step's `before_request`, or `before_tool`), the node exits once it is quiet, the supervisor restarts it, and the server resumes the runs. The same resume picks up runs lost to a crash, a SIGTERM or a dropped link, with a limit against crash loops.

## Flow

```text
api.nodes.reload() / POST /api/nodes/:id/reload / bun run node:reload
  → server: node.reload {epoch, force?}  (request-now)
  → node: refuse if unsupervised or the new code does not build → {scheduled: true}
  → node.pause: runs held at before_request (assistant) / before_tool; admission still allowed
  → quiet (no admission or tool in flight, every run held, reports delivered)
  → exit RELOAD_EXIT_CODE → supervisor restarts the node at once
  → hello {liveSessions}
  → server: session.resumePending for each running, non-live session on this node
            (failed, {started: false} or over AUTO_RESUME_LIMIT → settle as interrupted)
  → runs continue from assistant.ready / planned on the new code
```

## Steps

Each step started with a failing test (workflow.md). The current design is described in node-contract.md (*Pausing runs*, *Reloading a node*, *Crash recovery*), node-runtime.md (*Pause points*) and hot-reload.md (*Reloading the node*).

1. **Pause points in the runtime** (`pi-runtime.ts`): a `PauseGate` the node shares with its runtimes. While it is closed, the assistant step's `before_request` and every `before_tool` wait until it opens or the run's signal aborts; the hook returns, never throws. The runtime counts tool calls in flight (`tool_start`..`tool_end`) and held runs, and `isPaused()` says whether nothing would be cut off. `suspend()` closes the runtime without aborting its run. Tests: a run held at each point and suspended resumes in a new runtime without a second request or an interrupted tool; an abort releases a held run.
2. **`Node.pause` and shutdown** (`node.ts`): `pause({timeoutMs, force})` closes the gate and waits until every runtime `isPaused()` and no report is left to deliver. `shutdown()` suspends runtimes instead of aborting them. `main.ts` pauses (3 s, forced) on SIGTERM before closing its connection.
3. **Replay-safe resume:** `resumePendingOperation` answers whether the operation is now being driven (`true` when it already was) and `false` when nothing is pending, instead of throwing.
4. **`node.reload`** (protocol 8): params `{force?}`, result `{scheduled: true}`. The node needs `NodeOptions.reload` (`check`, `restart`), which `main.ts` supplies only under the supervisor (`REINS_NODE_SUPERVISED`). The check bundles the node's entrypoint with packages external.
5. **Supervisor:** a node exiting with `RELOAD_EXIT_CODE` restarts at once, without counting as a failure.
6. **Server resumes lost runs** (`session-runs.ts`, `node-hub.ts`): `recoverLostRuns` resumes within the budget and settles otherwise.
7. **Trigger surface:** `POST /api/nodes/:nodeId/reload`, `api.nodes.reload`, `bun run node:reload`.
8. **Process tests:** a node killed mid-run comes back and the run finishes without a manual resume; a reload requested over HTTP while a run is held restarts the node and the run finishes.
9. **Docs:** hot-reload.md, node-contract.md (*Process model*, *Crash recovery*, *Abort and resume*), node-transport.md (protocol version, methods), node-runtime.md (pause points), the scripting feature doc, then move this plan to `completed/`.
