# ADR-025: The Node Version Handshake

- **Status:** Accepted (amended by [ADR-028](028-nodes-run-the-machines-bun.md))
- **Amended:** [ADR-028](028-nodes-run-the-machines-bun.md): Reins no longer ships Bun. A node runs its machine's own Bun, of the server's major version, which the hello announces (`bunVersion`) and the server checks, answering `error` (`bun_version`) on a mismatch. `update` is `{buildId, sha256}`, the node home has no `bun`, and the manifest carries `bunMajor`. Where this record says otherwise below, ADR-028 holds.
- **Date:** 2026-10-10
- **Author:** Will (with Claude)
- **Builds on:** [ADR-021](021-explicit-node-reload.md) (the server resumes every run a node lost), [ADR-023](023-node-pairing-and-challenge-authentication.md) (authentication before the hello)

## Context

A remote node runs the node bundle its server built ([node-bundle.md](../dev/node-bundle.md)), and stays on its machine across server releases. The session protocol is lockstep: a node and its server speak exactly one `protocolVersion`, and the plan ([completed/remote-nodes.md](../plans/completed/remote-nodes.md) *Decisions*, formerly node-architecture.md *Versions*) keeps it free to change by never serving a node older than its server. So an older node must be told to update before negotiation fails, and the message telling it must be one every released node can read. Whatever the first remote release puts in the hello and its reply is bootstrap surface: it can grow, but never change incompatibly.

## Decision

**The hello announces the node's build, and its reply has a kind.** A node bundle sends `buildId` (the sha256 of its `reins.js`) in `node.hello`; a node from source (the local node) sends none. The reply is one of:

- `{kind: "ready", version, capabilities, epoch}`: negotiated, as before.
- `{kind: "update", buildId, sha256, bunVersion}`: install this build and restart on it. The node downloads it from `/nodes/builds/<buildId>/reins.js` on the server it is paired with (the reply names no URL), checks it against `sha256`, and fetches Bun `bunVersion`'s official release first if that is not the Bun it runs.
- `{kind: "error", code, message}`: the server cannot serve this node at all (e.g. a bootstrap format it no longer accepts). The node stops; the user reinstalls it. No server sends it yet.

**Both sides parse tolerantly.** The server parses the hello with `z.object` (fields it does not know are dropped, limits kept), so a newer node is read far enough to be answered. A node reads the reply's `kind` first: `ready` negotiates; `update` hands the build to the updater; `error`, an unknown kind or an `update` it cannot read is a refusal (`NODE_REFUSED`): the node logs it and stops, as when it is revoked, rather than redialing or crashing. The server checks its replies strictly as it sends them (`helloResult`).

**The server's rule.** In order: the node proves its key (authenticated transports), the server will serve it (not revoked or removed), then, for a hello announcing a build:

- a build other than the server's current one is answered `update`, whatever protocol versions it offers: the update must come before version negotiation fails;
- while the server's build is still running, the hello waits for it, at most 5 s (`HELLO_BUILD_WAIT_MS`, under the hello timeout), then fails with `NEGOTIATION_FAILED` and the node redials;
- with no build to offer (it failed), the node is served as it is if its protocol matches, and the server logs it.

A node with no build ID negotiates as before. A node is never told to update before it proved its key, and never once revoked.

**The update.** The node stops dialing, installs the build in its home (`builds/<buildId>/`, the Bun if needed, then `current` flipped atomically), closes its runtimes without aborting their runs (`Node.shutdown`, as on SIGTERM but without pausing: it cannot reach a pause point without speaking the new server's protocol) and exits with the restart code (75), which its launcher (`~/.reins/bin/reins`, `REINS_NODE_RESTART_EXIT_CODE`) answers by starting the new `current`. The server resumes the runs it lost (ADR-021). A failed download, checksum or Bun leaves `current` as it was; the node asks the server again after a backoff (5 s doubling to 5 min), so it follows the server if the server moves on meanwhile.

**The bootstrap surface** (changed only additively, across all releases): the hello envelope (`node.hello`'s params, and its being the first call after `node.authenticate`), the reply's kinds and fields, `node.authenticate`, the config file, the pairing request, the manifest, the bundle download path, the install script's URL and arguments, the node home's layout, the launcher and its restart code. The protocol version moved to 10 for the new reply shape; from now on it versions only what follows the hello.

## Consequences

- Session-protocol changes stay lockstep and free: a node never runs code newer than its server, and an older one updates before it is served.
- An upgrade cuts off what was in flight on the node (a model request is asked again, a tool call comes back "outcome unknown"); runs resume on the new build.
- A node run without its launcher (a bundle run directly) installs the update and exits 75 too, but nothing restarts it; it says so. A node from source is never told to update.
- The server keeps which build each node announced in memory (the node view's `build`, shown in Settings → Nodes as "updating…" or "old build"); a server restart forgets it, and every node's next hello records it again.
- Not done: the local node is still run from source by the supervisor and never updates (the plan's *Use it for the local node too*); `error` has no sender yet; the server does not cache Bun for machines without internet access.
- Details: [node-transport.md](../dev/node-transport.md) *4. The connection*, [node-bundle.md](../dev/node-bundle.md) *Updates*, node-contract.md *Process model*.
