# Node Architecture

Status: **local process split done; server-canonical storage done ([ADR-015](../adr/015-server-canonical-storage-stateless-node.md)); remote nodes not started.** Every session runs on a node; the server stores every session, dispatches work through a durable queue and serves the UI. The node holds nothing durable: its Pi runtime reads and commits each session on the server over the link. The local node is a separate process linked over a Unix socket. The completed phases are recorded in [completed/node-local-process-split.md](completed/node-local-process-split.md) and [completed/server-canonical-storage.md](completed/server-canonical-storage.md); the current design is in [node-contract.md](../dev/node-contract.md) and [node-runtime.md](../dev/node-runtime.md).

## Motivation

Support multiple machines (e.g. a Mac and a Linux box, or disposable cloud machines), each with their own checkouts, connected to one Reins server, and eventually a hosted server with users connecting their own machines as nodes. Browser traffic, including agent events, stays routed through the server.

```mermaid
graph LR
    Browser[Browser] <-->|HTTP + WS| Server
    subgraph Server host
        Server[Reins server\nproduct DB, canonical session storage,\ncommand queue, credentials]
        Local[Local node\nPi, tools, checkouts,\nno durable session state]
        Server <-->|JSON-RPC over\nUnix socket| Local
    end
    Remote[Remote node\nnot built] <-.->|JSON-RPC over\nWebSocket + TLS| Server
```

## Server-canonical storage (done)

The server's SQLite is the only session storage and the node holds nothing durable ([ADR-015](../adr/015-server-canonical-storage-stateless-node.md)). How it was delivered, the storage-traffic measurements behind the decision and the deferred write-behind decorator for high-latency links (not built: build it only after measuring a real remote node) are in [completed/server-canonical-storage.md](completed/server-canonical-storage.md).

## Simplification follow-up (implemented in an isolated worktree)

Keep Pi and host-local execution together on nodes. Moving Pi to a server-side worker process would retain much of the command/storage/lifecycle/recovery machinery and add another link to tools-only nodes; it is not the proposed simplification.

Prioritize deletions and deeper modules within the existing process split:

1. **Done: unused command-settlement waiting removed.** No `NodeHub.commandSettled`, dispatcher waiter map or waiter reconciliation. Tests observe queue settlement directly. Session-level `api.sessions.wait` stays.
2. **Done: child replies project on the server.** `session.settled` carries native `run_end.tipId`; the server reads that exact ancestry through `loadBranchMessages`. Node reply reads/promises and the reply/error wire fields are removed. Tests cover delayed settlement against a newer main tip, projection failures and the existing failed/aborted lifecycle effects. Child report/outbox/activity changes remain transactional. Protocol version is now **4**.
3. **Done: one process-lifetime hub/dispatcher.** Product handlers in `node-services.ts` swap per reload; existing node links/epochs and in-flight calls survive. Routing and dispatch use current product services. Handler install/uninstall is gone. `@reins/node-protocol` stays external to dev bundles to preserve schema/error identities; process-owned changes warn that restart is required. Real-process tests prove link preservation and in-flight delivery across reload. Real disconnect recovery and atomic claims stay. See [ADR-016](../adr/016-process-owned-node-hub.md).
4. **Done: one command-delivery module.** `nodes/commands.ts` resolves source/binding, sends the command and classifies the outcome. The extra `sendNodeCommand` wrapper and success `kind` vocabulary are gone; `NodeResult.value` preserves the validated wire result. Command and wire schemas reuse input/model fields and result schemas. Persisted intent remains distinct from execution-time binding; queued work remains distinct from immediate controls.
5. **Done, with user approval: dormant Claude SDK runtime deleted.** Implementation, runtime-specific tests/fixture, trace/repro scripts, SDK/CLI dependencies and import-rule exceptions are removed. Historical runtime identifiers remain readable/rejected as unavailable; future support would be a node integration.

Verification: root typecheck and lint pass; all **1,744 tests pass in two consecutive full runs**. Real-process interruption tests wait for the preceding run to settle and for the slow provider to start, rather than treating a committed message as proof of runtime readiness. Bundle tests verify that protocol constructors and process-owned database/store code are not cloned into reloadable handlers.

Rollout: changes were implemented/tested in `/tmp/reins-node-simplification`, away from the live checkout's watchers. **After importing, restart the server and node together** at a deliberate idle point; protocol 3 nodes cannot use protocol 4 settlements. Do not rely on hot reload for this cutover.

**Hydration clarification:** session hydration/replication is already gone. There is no active `session.hydrate`, `session.snapshot` or `session.provision`; old names remain in migration history/tests and can also appear in ignored, stale `packages/node/dist` build output (current package exports point to `src`). Moving an idle session updates its source and best-effort closes the old runtime. `hydratePrompt` remains intentionally: it resolves image attachment references into bytes for model-provider requests, not session relocation or transcript reconstruction.

## Remaining work

- [ ] **Idle runtime eviction:** close runtimes idle for a fixed period (they hold nothing durable), which also bounds node memory and picks up new node code between turns.
- [ ] **Forks and tree navigation on the server:** over the canonical copy (Pi's `createForkSnapshot` needs only a `SessionReader`); see [conversation-tree.md](conversation-tree.md).
- [ ] **Chunked storage calls:** `storage.read`/`storage.commit` are not chunked, so a read result or commit over the frame cap fails its run; a remote link with a smaller cap needs them chunked.
- [ ] **Reconnect-safe node calls:** a dropped link should cost only a reconnect. Today a `storage.commit` in flight at a drop fails its run (it is never resent), and a `session.settled` in flight is lost, so crash recovery settles a run that completed as interrupted. Remote links will drop on their own, so they need this anyway. Then make the hub reloadable. In order:
  - [ ] **Retry-safe commits:** resend an unanswered `storage.commit` on the next connection; the server acknowledges a commit it already applied (its entries present with the same IDs and content) instead of refusing it as a duplicate writer. State-derived, like command replay ([ADR-010](../adr/010-state-derived-idempotency.md)): no receipts.
  - [ ] **Retry-safe reports:** resend an unanswered `session.started`/`session.settled`; the server recognises a repeat by its `runId` and the run's state.
  - [ ] **Reloadable hub:** once a drop is harmless, a dev handler reload rebuilds the hub and closes its connections, and the node redials. Delete the process-owned machinery that exists only to keep links across reloads (the `restartRequired` rules for `node-link/`, the per-call `NodeHubServices` lookup, the rewriting of process-owned imports in dev bundles) and amend [ADR-016](../adr/016-process-owned-node-hub.md) and [hot-reload.md](../dev/hot-reload.md). `script.execute` stays non-retryable (it has side effects): a drop still fails that one tool call with "may have run". Until this lands, a change under `node-link/` needs a server restart even if the product code around it hot reloaded.
- [ ] **Node bundle spike:** prove a single-file `bun build` of the node runs a real session outside the repository (see *Versions* below).
- [ ] **Pairing and node authentication:** settings-page pairing codes, launcher `pair`, Ed25519 node keys, the server-first challenge, revocation (see *Remote nodes: decided direction* below). Test stolen, expired and competing codes, challenge replay, a wrong node ID in the hello, reconnect fencing and revocation.
- [ ] **Remote transport:** JSON-RPC over WebSocket at `/node-link` behind the same `WireSocket` seam, with authentication before any method is served. Bound prompt size to the remote frame cap; consider a per-node cap or fairness in the dispatcher so one slow node cannot hold every delivery slot.
- [ ] **Code delivery:** build IDs, the `ready`/`update`/`error` hello reply, launcher download and restart, auto-resume of runs interrupted across a build change.
- [ ] **Node-owned sources:** node config source roots reported in the hello, attached to projects in the settings page; the node resolves `sourceId → path` and rejects others.
- [x] **Node→server streams:** `stream.data`/`stream.end`/`stream.cancel` (protocol 5), the node sender paced by socket drain and the per-connection server registry exposing each stream as a `ReadableStream` (capped in memory). See node-transport.md *Streams*. `process.run` opens them.
- [ ] **Git and file operations behind the node** ([ADR-018](../adr/018-process-run-and-fs-methods.md)): git runs through the generic `process.run` stream with the git logic staying on the server (`Git` on `RemoteNode.spawn`); the file browser's filesystem reads are typed `fs.*` methods. **Done:** `process.run`, `fs.list`, `fs.read`, `fs.write`, binary stream chunks; uploads; file listing and file content (working tree and refs), branch and task operations, sync, spread/push/rebase, files at a ref and the diffs (the working-tree diff's temporary index built on the node by one `sh -c` script), all on the call's source (node-contract.md *Which checkout a call works in*; 503 when its node is offline). **Remaining:** which checkout the frontend's file, diff and git requests read: they use the project's default source for now, and how they pick one will be handled differently once projects support multiple sources. The server runs no git of its own: `Git` (`git.ts`) always runs on a source's node, including `createProject`'s default-branch detection (in the source the trigger creates, until project creation picks a node). Part of *Remote rollout*.
- [ ] **Background process output (later):** stream a node-side process's output over the same primitive, resuming from an offset after a reconnect (the node keeps the output; offsets are already absolute). Decide whether the server spills a long-lived stream to disk instead of failing it at the buffer cap.
- [x] **Remote rollout:** moving the remaining server-local operations behind the node (see *Remote readiness* below).
- [ ] **Credential lookups per runtime open:** opening a runtime makes hundreds of `credentials.get` calls, because Pi's model runtime checks every registered provider and logged-out results are not cached on the node. Cheap locally, costly remotely. Options: cache logged-out results until the next attach, or narrow which providers Pi checks.
- [ ] **Node management screen:** list nodes, connection status and project sources, with source selection for new sessions once projects have sources on several nodes (replacing the "first source" default with a per-project choice). Decide whether offline nodes appear in the source picker.
- [ ] **Process-test speed (optional):** fixed waits (`[slow:3000]`/`[slow:1500]` faux-provider stalls, a 2s sleep, reconnect backoff) are most of `server-process.process-test.ts`'s ~17s; a provider that blocks until the test releases it would roughly halve it.
- [ ] **Plugin-started nodes:** a plugin that starts a node for a session or task is a server-side placement decision (pick or create the source before the first command is dispatched), not a node-side provisioning step. Add it as a hook in source selection when there is a plugin to use it.

## Remote nodes: decided direction

The local split locks nothing in: the node stores nothing, the local node always ships and restarts with the server, and server schema changes are append-only migrations. A remote node is installed on another machine, so whatever the first remote release puts on that machine's disk or into its handshake is hard to change afterwards. The decisions below settle those parts.

### Trust model (decided)

- **Private network only.** Reins is exposed only on a private network (e.g. Tailscale). This is a deployment assumption, not something code checks or enforces. Anyone who can reach the server is effectively an administrator: the browser API is unauthenticated, so they can create pairing grants, change settings and run scripts. Frontend authentication is a prerequisite for any wider exposure and is out of scope here.
- **Nodes get every credential.** [ADR-013](../adr/013-server-holds-credentials.md) stands as is: any authenticated node is served `credentials.*` for every provider. No per-node scoping.
- **Node authentication still ships in the first remote release.** It is not there to defend against the network. It exists because a node's stored identity can only be replaced by re-pairing that machine, and because a stale or mistaken node (or a copy of the database) must not be able to pose as another node. Ship the keypair design below rather than a shared token we would have to migrate away from later.
- The server can already run arbitrary bash on a node through prompts, so letting the server deliver the node's code (below) adds no new trust.

### Pairing from the settings page (decided)

1. **Settings → Nodes → Add node** (optional name). The server creates a one-use pairing code (256 random bits), shows it once with the install command, and stores only its SHA-256, an expiry (10 minutes) and a consumed timestamp. A plain hash is enough: a 256-bit code cannot be brute-forced from its hash, so no server secret outside the database is needed. Never log the code.
2. **On the node machine** (requires Bun), the page's command fetches the launcher from the server and runs `pair <server URL>`. The launcher **prompts** for the code, keeping it out of shell history and process lists. It then generates an Ed25519 keypair (private key 0600 under `~/.reins-node/`) and posts the code, its public key and its hostname. The server consumes the grant atomically, so a code redeemed concurrently has one winner. It creates the `nodes` row bound to that public key and returns the node ID. The launcher writes its config: a `version` field, the server URL, the node ID, the key path and source roots.
3. The settings page shows the node and its connection status; sources are attached there (*Sources* below).
4. **Revoke** in the settings page disables the node: it closes the link and refuses the node's key on every later connection.

Deferred: key rotation (for now, revoke and re-pair), fingerprint confirmation, an audit log.

### Connection

- The node dials a WebSocket at a path on the existing HTTP server (`/node-link`), using `ws://` or `wss://` as the deployment provides. The private network carries the transport security, so TLS is not required. This endpoint is separate from the browser WebSocket and reads no cookies. The local Unix socket ([ADR-012](../adr/012-ndjson-unix-socket-local-link.md)) is unchanged; both sit behind the same `WireSocket` seam.
- **The server speaks first:** `{challengeId, nonce, …}`. The node signs a domain-separated tuple (`reins-node-auth-v1`, server origin, node ID, challenge ID, nonce). The server verifies the signature against the stored public key and the node's enabled state, consumes the challenge (also on failure) and binds the node ID to the socket. Only then does it accept `node.hello`, whose `nodeId` must match. Everything after the hello (epochs, fencing, heartbeat, outbox, *Link loss*) is unchanged.
- Remote links need a smaller frame cap than the local 64 MiB, so **chunked storage calls** and a prompt-size bound are prerequisites.

### Sources belong to the node

Today the server sends a binding's `cwd` and the node runs there. That is safe only while the node shares the server's machine. A remote node is the authority on its own paths: its config lists source roots, and its hello reports them. The settings page attaches a reported path to a project, which creates the `sources` row. The node then resolves `sourceId → path` itself and rejects a binding for a source it does not hold, or whose path differs. Open: whether sources are declared on the node (a launcher command) or picked in the settings page under node-declared roots, which would need a node-side directory listing.

### Versions: the server delivers the node's code (proposed)

The node is stateless and pure JS (Pi and zod, no native modules), so the server can hand a remote node the exact code that matches it, the way VS Code Remote installs its matching server on the remote machine. Two pieces live on the node machine:

- **Launcher:** small and rarely changed. It is fetched from the server at install time, and it owns the config, the key, pairing, authentication, the bundle cache and the node process.
- **Node bundle:** all of `packages/node` as one file (`bun build --target bun`), built and hashed by the server. The **build ID** is the hash. Bundles are cached on the node by build ID.

On connect, after authentication, the hello carries the node's `buildId` and the launcher's version. The server answers one of:

- `ready`: the normal negotiation.
- `update {buildId, sha256}`: the launcher downloads the bundle over its authenticated connection, verifies the hash, stops the running node and starts the new one.
- `error {code, minLauncherVersion?}`: e.g. "this launcher is too old". The launcher can then replace itself from the server the same way.

Consequences:

- **The session protocol stays lockstep and free to change**, as it is today. A node never runs code newer than its server, and an older node updates before it is served. There is no window of supported versions to maintain.
- **Only the bootstrap surface must stay compatible across releases:** the config file format, the pairing request, the auth challenge, the hello envelope (parsed tolerantly; `helloParams` is a `strictObject` today), the `ready`/`update`/`error` reply and the bundle download. Changes there must be additive.
- **Upgrade flow:** the server restarts on a new build, so the node's link drops. The node redials, receives `update` and restarts on the new bundle. Runs that were in flight are settled as interrupted (node-contract.md *Crash recovery*). To make an upgrade a pause rather than lost work, the server **auto-resumes runs interrupted across a build change**: it knows because the reconnecting node's build ID differs from its previous connection's. A server restart without a build change keeps runs alive through *Link loss*, as today.
- The local node is unchanged: the supervisor runs it from source. Running it through the launcher too is optional later.

First step: a spike proving that a single-file `bun build` of `packages/node/src/main.ts` runs a real session (Pi, host tools, resources) outside the repository.

## Remote readiness

Server code that still assumes the checkout is local and must move behind node requests (or fail closed for remote sources) before a remote session is complete:

- None left: git, file listing and reading, diffs and uploads all reach a checkout through its node (`process.run`, `fs.list`, `fs.read`, `fs.write`).

How they move ([ADR-018](../adr/018-process-run-and-fs-methods.md), node-contract.md *Checkout operations*), all `request-now` (answered immediately, `unavailable` when offline, never queued):

| Request | Inputs → result |
|---|---|
| `process.run` (built) | sourceId, cwd, argv (no shell), env → a stream of stdout ending with the exit. Every git operation: the server keeps the git logic and runs it here instead of on its own checkout. |
| `fs.list`, `fs.read` (built) | sourceId, cwd, scoped relative path → one directory's entries; a file's bytes as a binary stream. Rejects escaping paths. Working-tree reads only: a file at a ref is `git show` through `process.run`. |
| `skills.list` (built) | sourceId, cwd → the node's current skill metadata, `{skills: [{name, description}]}` (no bodies; node-contract.md *Skills*). The server sends the source's path like a binding, since the node has no source configuration to verify it against yet. |

`sourceId` is resolved server-side from the session; the node verifies it maps to its configured path (once nodes own their sources). Never accept a browser-supplied host path. `process.run` does accept an arbitrary command, from the server only: the server can already run anything on a node through a prompt (*Trust model*), so this adds no trust; what it must never do is build a command from browser input except as separate arguments (no shell).

**Skills and resources are node-local.** Two sources of one project can have different repo skills, user-global skills and AGENTS files; the node discovers them in the bound cwd at every open, and slash expansion runs on the node before admission. For UI suggestions, `skills.list` is a live per-source view (refresh on open; an offline source shows no inventory). Explicit slash invocation that cannot resolve should return a typed admission error (`skill_not_found`/`skill_read_failed`) rather than sending unexpanded text. Pinning skill versions is deferred. Tests should cover two sources with different skills, invocation on a server without the repo, and relative reference reads.

**Other remote gaps:** a control path for auth changes to reach nodes (today a logout reaches a node only on reconnect or next refresh).

## Cloud nodes (future)

Disposable cloud machines (e.g. Fly Sprites, which resume from checkpoint in about a second) are natural nodes, and a stateless node suits them: there is nothing on the machine to back up or re-hydrate. Reins would manage only a sleep/wake lifecycle: track nodes as online, sleeping or offline; on a prompt for a sleeping wakeable node, trigger a wake and let the queued command deliver on reconnect (the command queue already holds work for disconnected nodes); show "Starting…" for a waking cloud node and "Offline" for an unreachable personal machine. Provisioning the machine (tools, clones, CLI auth) stays outside Reins. A distant cloud node is the case most likely to want the deferred write-behind decorator.

## Open questions

- **Frontend authentication:** not needed while Reins is exposed only on a private network (see *Trust model*); required before any wider exposure. Account authentication and user-scoped authorization are separate from node identity; passkeys are a candidate.
- **Privacy and trust:** a node lets the server route prompts that execute on the user's machine, and the server receives all events and transcripts. Fine for self-hosting; for a hosted multi-user service, explore node-side tool permissions and approval gates, audit logging of server-initiated commands, scoped node permissions and end-to-end encrypted storage. Self-hosted remains the primary model.
- **Latency:** server-relayed events add a hop for remote nodes. Direct browser–node streaming (e.g. WebRTC data channels with the server as signaling) is a possible later optimization with fallback to the relay.
- **Multiple sources per project:** the model allows it; decide the default-source policy and UX once it is real.
- **Protocol standards:** whether ACP could carry the server–node command/event channel (see [ADR-006](../adr/006-acpx-as-runtime-replacement.md) for the runtime-level evaluation).
