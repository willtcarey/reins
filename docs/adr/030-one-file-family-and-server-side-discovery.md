# ADR-030: One Family of File Methods; the Server Discovers the Checkout's Environment

- **Status:** Accepted
- **Date:** 2026-10-12
- **Amends:** [ADR-018](018-process-run-and-fs-methods.md) (the `fs.*` methods are no longer the file browser's alone, nor confined to the checkout on the node), [ADR-029](029-sessions-on-the-server-nodes-host-tools.md) (`env.fs` and `checkout.environment` go; `env.exec*` is renamed `pi.exec*`)

## Context

Protocol 12 had two families of file methods on the node. `fs.list`, `fs.read` and `fs.write` (ADR-018) served the file browser and uploads: paths relative to the checkout and confined to it on the node, refusals as RPC errors, a partly sent upload's chunks kept by its path. `env.fs` (ADR-029) served the agent's tools as Pi's `ExecutionEnv`: any path, Pi's `Result` with its file error codes, chunks kept under a write ID so any chunk may be sent again. Both read and wrote the same files on the same machine.

A third method, `checkout.environment`, had the node discover the checkout's context files (`AGENTS.md` in the checkout and its ancestors) and skills (`.agents/skills`) and send them with their content, plus where its REINS docs were. The server discovered its own `~/.agents` the same way with a second copy of the same discovery code, so the two could drift, and every change to the rules was a protocol change and a node update.

The node's confinement of `fs.*` to the checkout protected nothing: under the trust model (node architecture plan) the server can already run anything on a node, through `process.run` or a shell command.

## Decision

**One family of file methods, `fs.*`, with Pi's semantics.** `fs.info`, `fs.list`, `fs.read`, `fs.write`, `fs.absolutePath` and `fs.canonicalPath` do what Pi's local environment does on the node (its `NodeExecutionEnv`): a path resolves against the call's `cwd` (the source's checkout, `~` the node's home), nothing is confined, and each answers Pi's `Result`: a value, or a file error with Pi's code, message and path. `fs.read` streams the file from disk with an optional `maxBytes`; `fs.write` crosses in chunks under a write ID (any chunk safe to send again). `fs.list` lists a directory's children as Pi's `listDir` does (a symlink reported as one, not followed). Pi's `exists` is `fs.info` answering `not_found`. They serve the agent's tools, the server's discovery and the file browser alike.

- **The server confines what a browser names.** The file browser, file content and uploads resolve a path against the checkout and refuse one outside it (lexically, as the node did) before calling the node with the absolute path. The file browser leaves symlinks out of its listing, as before.

**The server discovers the checkout's environment.** It reads the checkout's `AGENTS.md` files and runs Pi's own skill discovery (`loadSkills`) over the session's remote environment, which now serves `listDir`, exactly as it discovers its own `~/.agents` over Pi's local environment. One discovery for both, Pi's. A discovery the node could not answer (not connected in time, its link failing past the retries, a failure of the node) fails rather than being taken for a checkout without context files or skills: the remote environment used for it is *strict*, throwing what Pi's contract would answer as a file error.

**The node says where its docs are in its hello** (`docs: {dir, devDocs}`, an optional field: bootstrap surface only grows, ADR-025). Where an install's docs are is a fact about the node, not about a checkout.

**Pi's shell commands are `pi.exec`, `pi.execAttach` and `pi.execKill`.** They run Pi's `exec` on the node, its shell, capture and spill file, which is specific to Pi; the namespace says so. Git keeps `process.run`: a raw argv, raw stdout and the stderr's tail, with no capture.

Protocol 13. As for any protocol change, the server and its nodes move together: a remote node updates itself on connect (ADR-025), the local node restarts with `bun run dev`.

## Options considered

- **Rename `checkout.environment` to `source.environment`.** Rejected: the method would remain, and with it the second copy of discovery on the node.
- **Merge `process.run` into the shell commands** (one `process.start` with an output mode, or git run through Pi's `exec`). Not now. Pi's `exec` captures a bounded view of merged stdout and stderr as text, and git needs all of its stdout, separate, as bytes. A single path would mean the node streaming raw output and the server running Pi's capture, which Pi does not export, with the spill file still kept on the node where `read` finds it.

## Consequences

- The node holds no discovery code (`checkout-environment.ts` goes) and no checkout confinement. Its file operations are Pi's, so the agent's tools get what a local environment returns and the file browser gets the same answers.
- Discovering a checkout's skills takes several round trips instead of one (Pi's `loadSkills` reads each directory's ignore files, lists it and reads each skill, one call at a time). Free on the local socket; on a remote link it adds latency to the first request of a run, slash expansion of a checkout skill (bounded at 10 s) and skill suggestions (5 s). A larger remote environment call, or caching between runs, is an optimization to make once measured.
- An uploaded file is written with Pi's `writeFile` once its last chunk arrives (as the agent's writes already were), instead of renamed into place: a file being written is visible for the moment of that write. Its chunks are still kept in the node's data directory until then.
- The bounds that only `checkout.environment` needed (`MAX_CHECKOUT_ENVIRONMENT_BYTES`, `MAX_LISTED_SKILLS`) go.
