# ADR-018: Git Over a Generic `process.run`, Typed `fs.*` for File Browsing

- **Status:** Accepted
- **Date:** 2026-10-03

## Context

The server's git and file operations (file listing, diffs, file content, branch operations) read the server's own checkout, which a remote node's source is not on. The node architecture plan proposed typed node requests for each one (`workspace.list`, `workspace.read`, `workspace.status`, `workspace.diff`) and said never to accept an arbitrary command. Typed requests would move the git logic into the node: every change to it would need a node restart (and later a node code update on remote machines), and each operation would add a wire method and a capability.

## Decision

- **Git runs on the node through one generic method, `process.run {sourceId, cwd, streamId, argv, env?, binary?}`.** It opens a stream ([ADR-017](017-node-link-streams.md)) of the process's stdout, and the stream's end frame carries the exit (code or signal, and the tail of stderr). Cancelling the stream kills the process. The git logic (which commands to run and how to read their output) stays on the server (`Git`, built on an injected spawn: `RemoteNode.spawn`, or a local one until every caller has moved), where it hot reloads.
- **`argv`, never a shell string.** The server builds arguments from browser input (paths, branch names). Passing them as separate arguments keeps today's safety; a caller that wants a shell must say `["sh", "-c", …]`.
- **Filesystem reads for the file browser are typed `fs.*` methods** (`fs.list`, `fs.read`, and `fs.write` for uploads). They are not git, and their shell equivalents (`find`, `stat`) differ between Linux and macOS nodes.
- **Streams gain binary chunks** (`encoding: "base64"`, offsets counting raw bytes), so file bytes and `git show` of binary files cross intact.

This reverses the plan's "never accept an arbitrary command" for commands from the server. It adds no trust: the trust model already lets the server run anything on a node through a prompt. What must still never happen is a browser-supplied host path, or a command assembled from browser input other than as separate arguments.

## Consequences

- Moving an operation behind the node is mostly mechanical: its model's `Git` is built on `RemoteNode.spawn` instead of a local spawn. The node changes only for new filesystem methods.
- The same method serves background processes later (start, stream output, cancel kills, resume from an offset).
- A multi-step operation makes one round trip per git command. This is free locally and costs latency remotely. Steps that keep temporary state need that state on the node: the working-tree diff builds its temporary git index in the same `sh -c` process that runs the diff, so it costs one round trip and leaves nothing behind. A node-side helper for a hot multi-step path is an optimization to make once it is measured.
- Few wire methods: `process.run`, `fs.list`, `fs.read` and `fs.write`, rather than one per operation.
