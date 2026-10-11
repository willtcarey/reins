# Nodes

A **node** is a machine that runs Reins sessions: the agent's tools, its checkouts and its model calls run there, while the Reins server keeps the sessions, settings and credentials and serves the web app. Reins runs one node beside the server (the **local** node). You can add others: another computer, a VM, a cloud machine. Each one needs network access to the Reins server, `curl`, `sh`, `git`, `bash` and [Bun](https://bun.sh) of the same major version as the server's (Bun 1.x for a server on Bun 1.3), installed and on your `PATH`: Reins does not install Bun. Nodes run on Linux and macOS.

## Installing a node

In **Settings → Nodes**, click **Add node** ([settings.md](settings.md) *Nodes*). The page shows a one-line command with a pairing code. Run it on the machine you are adding:

```sh
curl -fsSL https://reins.example.ts.net/nodes/install | sh -s -- <code>
```

The command:

1. checks that the Bun on your `PATH` is of the server's major version, then downloads the server's node code, checking it against its checksum;
2. pairs the machine with the server using the code;
3. starts the node in the background and waits until it connects.

Without Bun, or with another major version of it, the command stops at once, saying which Bun it needs (`Reins needs Bun 1.x on PATH: install it from https://bun.sh, then run this command again`); install it and run the command again.

Its last line says what happened: `Node "<name>" (<id>) connected to <server>` when it worked, or what failed and where to look. It exits non-zero on failure. The settings page shows the node as connected at the same time.

The pairing code works once and expires after 10 minutes. It goes to the server only as part of the pairing request, never in a URL, and is never printed or logged.

**Running it again** is safe, with the same command and the same (now used) code: a machine already paired with this server is not paired again, and a node already running is left running. Run it again to restart a node that stopped. If the server's node code changed since, it installs the new code and restarts the node on it.

If the node was removed in Settings (or revoked), run the install command again with a **new** code from **Add node**: the server refuses the old pairing, so the machine is paired again with the new code, and the node starts. It appears in Settings as a new node.

If the server cannot build the node's code, or is still building it, the install command says so in one line and exits non-zero; try again later, or see the server's log.

A machine already paired with another Reins server is refused (exit 3), without using the code. To move it to this server, run `~/.reins/bin/reins node pair --force <server URL> <code>`, then the install command again.

## What it installs

Everything goes in `~/.reins` (or the directory named by `REINS_NODE_DATA_DIR`), readable only by you:

| Path | What |
|---|---|
| `builds/<build>/` | The node's code (`reins.js`) and the Reins feature docs that come with it |
| `current` | The build in use |
| `bin/reins` | The `reins` command for this node, which runs it on the Bun it was installed with |
| `node.json`, `keys/` | The pairing: the server, the node's ID and its private key |
| `logs/node.log` | The node's output |
| `run/node-status.json` | Whether the node runs, and whether it is connected |

Nothing is installed outside it, and Bun stays where you installed it. To use `reins` without its path, add `~/.reins/bin` to your `PATH`.

## Running the node

The node runs in the background until you stop it, the machine restarts or the server refuses it. It is not a system service: after a restart, start it again.

- `~/.reins/bin/reins node start` starts it in the background and waits until it connects.
- `~/.reins/bin/reins node stop` stops it. Its sessions' runs pause; the server resumes them when the node next connects.
- `~/.reins/bin/reins node status` shows the server it is paired with, its node ID, the build it runs, its log and, on the last line, whether it is running and connected. It exits 0 when the node is connected, 3 when it is not running and 4 when it is running but not connected.
- `~/.reins/bin/reins node run` runs it in the foreground instead, logging to the terminal, until Ctrl-C.

While it runs, the node reconnects by itself whenever the server restarts or the network drops. If the server refuses it (the node was removed or revoked in Settings), it stops, and `status` says so.

## Updates

Nodes update themselves: there is nothing to do on the node's machine when Reins is upgraded. When the server restarts on new code, each node, as it reconnects, is told to update; it downloads the server's node code, checks it, switches to it and restarts on it, then reconnects. This takes a few seconds. Meanwhile its sessions' runs wait, and they continue once it is back. Work that was in flight when the server restarted is interrupted: a model request is asked again, and a command the agent was running comes back to it as interrupted. Updates never change Bun: that is yours to upgrade (*Upgrading Bun*).

Settings → Nodes shows the node as **updating…** until it is back. The node's log says what it is doing (`the server runs build …; updating to it`, `build … installed; restarting on it`), and `reins node status` says **Restarting on a new build** meanwhile.

If a download fails, the node keeps its current code and tries again a little later (from 5 seconds up to every 5 minutes), saying why in its log. A node run with `reins node run` from the bundle directly, rather than with `~/.reins/bin/reins`, installs the update but cannot restart itself: it says so and exits; start it again with `~/.reins/bin/reins node start`.

Its output is appended to `~/.reins/logs/node.log`.

## Upgrading Bun

A node runs on the Bun it was installed with (the one on your `PATH` then), and needs the same major version as the server's. Any release of that major version is accepted, but one older than the server's may fail while it runs; keeping Bun current avoids that.

When the server moves to a new major version of Bun, each node stops as it reconnects: Settings shows it disconnected, and `~/.reins/bin/reins node status` (and its log) says `This server needs Bun 2.x; this node runs 1.3.9. Upgrade Bun on <machine>, then: reins node start`. Upgrade Bun on that machine, then:

- if you upgraded it in place (`bun upgrade`, or Bun's own install script again), run `~/.reins/bin/reins node start`;
- if the new Bun is somewhere else (a version manager, Homebrew), run the install command again (any code from **Add node**: the machine is already paired, so the code is not used). It records the Bun now on your `PATH` and starts the node.

If the Bun the node was installed with is removed, `~/.reins/bin/reins` says so (`Reins: this node's Bun (<path>) is gone…`); install Bun and run the install command again.

## Checkouts

A node works in the checkouts of projects on it; it keeps no list of its own. Once the node is connected, put a project on it: add a project and choose the node, or open an existing project's settings and use **Add checkout** with the node and the directory's path on that machine ([projects.md](projects.md)). The node checks that the directory exists. From a terminal, on that machine: `~/.reins/bin/reins source add <path> --project <id>` (a relative path is resolved where you run it); elsewhere, name the node with `--node <nodeId>` and give an absolute path. `reins source list` lists every project's checkouts. **Settings → Nodes** lists each node's checkouts.

## Uninstalling

1. `~/.reins/bin/reins node stop`
2. `rm -rf ~/.reins`
3. Remove the node in **Settings → Nodes** ([settings.md](settings.md) *Nodes*: a node whose checkouts belong to projects cannot be removed).
