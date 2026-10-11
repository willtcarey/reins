# ADR-028: Nodes Run the Machine's Own Bun, of the Server's Major Version

- **Status:** Accepted
- **Date:** 2026-10-11
- **Author:** Will (with Claude)
- **Amends:** [ADR-025](025-node-version-handshake.md), whose `update` reply named the exact Bun a node had to run and had it fetch Bun's release

## Context

A node runs the node bundle on Bun. Until now Reins pinned the server's exact Bun on every node: the install script detected the OS and CPU (musl, AVX2, Rosetta), downloaded Bun's official release from GitHub into `~/.reins/bun` with `unzip`, and an `update` reply carried `bunVersion`, which made the node fetch that release too. That is a second installer, kept in sh and in JS, for a runtime most users of a Bun-based tool already have; it needs GitHub (and `unzip`) on every node machine, and puts Reins in charge of a runtime the user also uses for other things. Nothing has been released, so the bootstrap surface can still change.

## Decision

**Reins ships no Bun. A node runs the Bun installed on its machine, which must be of the same major version as the server's; nothing finer is required.**

- **The install script** needs `bun` on `PATH` and checks that `bun --version` has the server's major version (templated into the script as `bun_major`). Without one it fails with one line: `Reins needs Bun <major>.x on PATH: install it from https://bun.sh, then run this command again` (another major version: the same, naming the Bun it found). It downloads no Bun and detects no platform; it needs `sh`, `curl`, `sha256sum` or `shasum`, and `bun`. It runs `reins node setup` with that Bun.
- **The launcher** records the absolute path of the Bun that wrote it (`process.execPath` in `installBuild`: the install script's Bun at setup, the launcher's own at an update), so a node started in the background does not depend on `PATH`. A Bun no longer there fails the launcher with one line saying to install Bun and run the install command again.
- **The hello** carries `bunVersion` (`Bun.version`). The server answers a node of another major version with `error {code: "bun_version", message}`, the first sender of the `error` reply. The server's checks run in this order: the node proves its key, may connect (not revoked), runs the server's Bun major, runs the server's build, speaks the protocol. So a node on the wrong Bun is never told to install a build. The message says what to do (`This server needs Bun <major>.x; this node runs <version>. Upgrade Bun on <host>, then: reins node start`). The node stops as refused and reports the message, with the reply's code. The CLI then prints the message without the hint to pair again, and `reins node setup` does not pair again.
- **Updates** download, check and install the build only. The `update` reply is `{buildId, sha256}`. The manifest carries `bunMajor` instead of `bunVersion`. The node home has no `bun`.

## Consequences

- The install script is simpler: no platform detection, no download from GitHub and no `unzip`. Node machines without internet access only need Bun, installed however their owner installs software.
- The user owns Bun: they install it, upgrade it and choose how. A server that moves to a new major version refuses its nodes until each machine's Bun is upgraded. Each node says so in its log and in `reins node status`, and Settings shows it disconnected.
- Version skew within a major version is untested. A node on an older minor than the server's may meet an API the bundle uses and fail at runtime; the fix is to upgrade Bun.
- The launcher's path is the resolved one. A Bun upgraded in place (`bun upgrade`) is picked up at the next start. One installed elsewhere (a version manager, Homebrew's versioned directories) leaves the old path, or none. Running the install command again records the Bun now on `PATH`.
- A hello without `bunVersion` is not checked. Every node sends one. A dev server whose protocol package predates the field drops it until it restarts.
- Details: [node-bundle.md](../dev/node-bundle.md) *Bun*, *The install script*, *The node home*; [node-transport.md](../dev/node-transport.md) *Details: Bun, builds and updates*; [nodes.md](../features/nodes.md) *Upgrading Bun*.
