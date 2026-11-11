# ADR-039: Node processes: one primitive, owned by its connection; git and `nodes.run` run on it to their end

- **Status:** Accepted
- **Date:** 2026-11-08
- **Author:** Will (with Claude)
- **Amends:** [ADR-018](018-process-run-and-fs-methods.md) (`process.run` goes: git runs on `process.start`), [ADR-013](013-server-holds-credentials.md) (secrets reach a node as a process's environment), [ADR-029](029-sessions-on-the-server-nodes-host-tools.md) (`pi.exec` is the agent's bash only)

## Context

Stdio MCP servers are to run on the session's node, the server staying the MCP client. That needs a process on a node that the server writes to (stdin) and reads from (stdout, newline-delimited JSON-RPC) for as long as it is in use, not tied to a tool call. The node had two ways to run things: `process.run` (git: argv, raw stdout on a stream, stderr's tail at the end, no stdin, killed with its stream) and `pi.exec` (the agent's bash: Pi's bounded, merged and sanitized output view, kept 60 s after a dropped link and reattached by offset, waited for by a node reload). `nodes.run` was on `pi.exec`, with a spill file read back past 1 MiB.

## Decision

**One process primitive on the node: `process.start`** (protocol 17), with `process.write` (stdin, base64 chunks, answered once the pipe took them) and `process.stop`. Its stdout and stderr come in one stream, as tagged frames in the order the node read them, ending with the exit once both pipes have closed: so the exit never arrives before the output, and stderr needs no stream or tail of its own. `process.run` is removed. A run to completion is a wrapper on the server: `NodeDirClient.spawner` starts with `stdin: false`, reads stdout and takes the exit from the stream's end. Git and `nodes.run` (`bash -c` with stderr joined to stdout) use it. `pi.exec` stays as it is, for the agent's bash only: its view, spill and reattachment are what a tool call needs, and Pi's `exec` takes no input.

**A process belongs to its output stream, so to the connection that started it.** Cancelling the stream or losing the connection stops the process; nothing reattaches it. The server's handle (`NodeProcess`) then reports `exited` with an error. MCP treats a lost process as a lost connection and starts it again at the next call, and MCP connections already close at every app reload, which drops node links too. A node reload or shutdown stops its processes; a pause does not wait for them.

**Stopping reaches the process group**: each process is started detached (its own group); stopping closes stdin, sends SIGTERM to the group, then SIGKILL after `PROCESS_STOP_GRACE_MS` (3 s). When the process exits by itself, what is left of its group is stopped too, so an `npx`/`uvx` wrapper's server and a stray background child do not outlive it.

**Bounded both ways.** Stdout: the server's stream buffer (`MAX_STREAM_BUFFER_BYTES`), so a process whose stdout nobody reads fails, and a line length (`maxLineBytes`, 8 MiB by default) enforced where lines are split, on the server, which must join a line's chunks anyway. Stdin: writes are serialized and answered once the pipe has the bytes, and the server holds at most `MAX_PENDING_INPUT_BYTES` (16 MiB) not yet taken. Stderr: the server keeps its last 64 KiB characters. On the node, output the link has not taken is not bounded: Bun (1.3.9) reads a child's pipes as fast as they fill, paused or not (measured: 200 MB read into memory), so the server's limit, which stops the process, is the bound. At most `MAX_NODE_PROCESSES` (64) run at once on a node, git's included; one more is refused `unavailable`, retryable (it certainly did not start). The spawner waits that out, for up to its retry window even when its client does not wait for the node, so git calls in parallel queue rather than fail. A long-running caller gets the refusal.

**Environment values may be secrets** (ADR-013 keeps credentials on the server; an extension may still choose to give a value to a process, as `nodes.run`'s `env` already did). They cross the link once, in `process.start`, and the node keeps nothing of them after it spawned the process; neither side logs call parameters. They are in the process's environment on the node (`/proc/<pid>/environ`, readable by the node's user), never in its arguments.

**Extensions only.** `reins.nodes.spawn` is not a `ScriptMethod`: a process outlives the call that starts it, and a script's work ends with the script. A session's own background processes need a lifecycle the session owns (its deadline, its close, a lost process told to the session; docs/TODO.md), which is not built. An extension's processes are stopped when it is unloaded (a disposer, a reload, turning it off), and when the `signal` it gave aborts.

**Tool providers know their caller.** `ToolProvider.search` and `call` get `sessionId: string | null`, the calling session's ID; null for an extension's own `reins.tools`. Only the ID: the provider reads the session's project, task and node with `reins.sessions.get` (a session cannot move while its script runs), so the core passes no copy of its row. A script method's `ScriptContext` is the same, `{ sessionId, signal? }` (its `projectId` and `taskId` went: no extension read them). A provider can then run a tool on the session's node, or hide one from a session.

## Options considered

- **Extending `pi.exec` with stdin.** Rejected: Pi's `exec` has no input, and its output view (merged, sanitized, cut at 1 MiB) breaks JSON-RPC.
- **`process.start` beside `process.run`.** Rejected: the same spawn, stderr tail and stream ownership twice; git gains process groups and the stop sequence by sharing it.
- **Keeping a process for a grace period after a dropped link and reattaching by offset**, as `pi.exec` does. Not now: MCP restarts on a lost connection, and app reloads already close MCP connections. Session-owned background processes may need it.
- **Stderr on a stream of its own** (`process.stderr`, the node's tail then what follows). Replaced: its end and the exit came on separate streams, so the exit could arrive before the last of stderr.
- **Line framing on the node.** Rejected: the stream splits lines into chunks again, so the server would join them anyway; one place splits and bounds them.
- **Exempting one-shot runs from the process limit.** Rejected: a mode flag; waiting on a retryable refusal costs nothing.
- **`spawn` for scripts.** Not yet (above).

## Consequences

- Protocol 17: a server and node must restart together; an older node from source is refused with "the node is too old: update it", a node bundle is told to update.
- Git's stdout always crosses as base64 (a third larger than text on the wire); the bytes are the same as before.
- `nodes.run`'s output is no longer limited by Pi's view, and no spill file is written or removed; it is bash (`bash` on the node's `PATH`).
- A dropped link (a server reload included) stops every process the server started on that node.
