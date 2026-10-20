# Nodes

A **node** is a machine where Reins sessions do their work: the agent's tools (reading, writing and editing files, running commands) and git run there, in the project's files. The sessions themselves run on the Reins server, which keeps them with the settings and credentials, makes the model calls and serves the web app. So a model set up on the server (a provider, a sign-in, a custom endpoint) works for sessions on every node, and a node needs no model configuration, credentials or Pi setup. Reins runs one node beside the server (the **local** node). You can add others: another computer, a VM, a cloud machine. Each one needs network access to the Reins server, `curl`, `sh`, `git` and `bash`. Nodes run on Linux and macOS.

## Installing a node

In **Settings → Nodes**, click **Add node** ([settings.md](settings.md) *Nodes*). The page shows a one-line command with a pairing code. Run it on the machine you are adding:

```sh
curl -fsSL https://reins.example.ts.net/nodes/install | sh -s -- <code>
```

The command:

1. downloads Bun (the version the server runs) from Bun's GitHub releases, unless it is already there, and the server's node code, checking the download against its checksum;
2. pairs the machine with the server using the code;
3. starts the node in the background and waits until it connects.

Its last line says what happened: `Node "<name>" (<id>) connected to <server>` when it worked, or what failed and where to look. It exits non-zero on failure. The settings page shows the node as connected at the same time.

The pairing code works once and expires after 10 minutes. It goes to the server only as part of the pairing request, never in a URL, and is never printed or logged.

**Running it again** is safe, with the same command and the same (now used) code: a machine already paired with this server is not paired again, and a node already running is left running. Run it again to restart a node that stopped. If the server's node code changed since, it installs the new code and restarts the node on it.

If the node was removed in Settings (or revoked), run the install command again with a **new** code from **Add node**: the server refuses the old pairing, so the machine is paired again with the new code, and the node starts. It appears in Settings as a new node, with no sources: add the projects' sources on it again (*Sources*), then move the sessions of the removed node to it with **Move to node…** ([settings.md](settings.md) *Nodes*).

If the server cannot build the node's code, or is still building it, the install command says so in one line and exits non-zero; try again later, or see the server's log.

A machine already paired with another Reins server is refused (exit 3), without using the code. To move it to this server, run `~/.reins/bin/reins node pair --force <server URL> <code>`, then the install command again.

## Its name

A node is shown in Reins under a name. It gets the name you gave **Add node**; without one, the machine's name: on macOS the name set in System Settings → General → Sharing (its local hostname, such as `beepboop-v2`, rather than the network's name for it, such as `Mac.lan`), elsewhere its hostname. Rename it at any time in **Settings → Nodes** ([settings.md](settings.md) *Nodes*), the local node too.

## What it installs

Everything goes in `~/.reins` (or the directory named by `REINS_NODE_DATA_DIR`), readable only by you:

| Path | What |
|---|---|
| `bun` | Bun, the runtime the node runs on |
| `builds/<build>/` | The node's code (`reins.js`) and the Reins feature docs that come with it |
| `current` | The build in use |
| `bin/reins` | The `reins` command for this node |
| `node.json`, `keys/` | The pairing: the server, the node's ID and its private key |
| `logs/node.log` | The node's output |
| `run/node-status.json` | Whether the node runs, and whether it is connected |

Nothing is installed outside it. To use `reins` without its path, add `~/.reins/bin` to your `PATH`.

## Running the node

The node runs in the background until you stop it, the machine restarts or the server refuses it. It is not a system service: after a restart, start it again.

- `~/.reins/bin/reins node start` starts it in the background and waits until it connects, saying why while it is not connected yet. If the node is already running but not connected, `start` restarts it (saying why it could not connect, when the node knows); if it is running and connected, or is restarting itself on an update, `start` leaves it alone.
- `~/.reins/bin/reins node stop` stops it, once the commands running on it have finished (it waits a few seconds, then cuts them off). Its sessions keep running on the server and wait for it (*While a node is offline*).
- `~/.reins/bin/reins node status` shows the server it is paired with, its node ID, the build it runs, its log and, on the last line, whether it is running and connected, and if it is running but not connected, since when and why (for example `cannot reach the server: …`, or `negotiation failed: No common protocol version: …`). It exits 0 when the node is connected, 3 when it is not running and 4 when it is running but not connected.
- `~/.reins/bin/reins node run` runs it in the foreground instead, logging to the terminal, until Ctrl-C.

While it runs, the node reconnects by itself whenever the server restarts or the network drops. If the server refuses it (the node was removed or revoked in Settings), it stops, and `status` says so.

## Updates

Nodes update themselves: there is nothing to do on the node's machine when Reins is upgraded. When the server restarts on new code, each node, as it reconnects, is told to update; it downloads the server's node code (and the version of Bun it needs, if that changed), checks it, switches to it and restarts on it, then reconnects. This takes a few seconds. Meanwhile its sessions' runs wait for it, and they continue once it is back. A command the agent was running on the node when it restarted comes back to the agent with an unknown outcome. The server itself pauses its runs when it stops and continues them when it starts again.

Settings → Nodes shows the node as **updating…** until it is back. The node's log says what it is doing (`the server runs build …; updating to it`, `build … installed; restarting on it`), and `reins node status` says **Restarting on a new build** meanwhile.

If a download fails, the node keeps its current code and tries again a little later (from 5 seconds up to every 5 minutes), saying why in its log. A node run with `reins node run` from the bundle directly, rather than with `~/.reins/bin/reins`, installs the update but cannot restart itself: it says so and exits; start it again with `~/.reins/bin/reins node start`.

Its output is appended to `~/.reins/logs/node.log`.

## While a node is offline

A session's history stays readable, and you can still send it prompts: they are accepted at once. What needs the node waits for it:

- A run starts working (checking out the task's branch, reading the project's instructions and skills) only once the node is connected, however long that takes. You can stop it meanwhile.
- During a run, a file operation or command waits for the node to come back: about half a minute for a file operation and a minute and a half for a command, after which the agent is told it failed. A short drop (the server reloading, the network) goes unnoticed: a command keeps running on the node and its output is picked up again.
- If the node restarted, a command it was running is lost: the agent is told its outcome is unknown.
- Invoking a skill (`/name`) fails until the node is back. The `/` suggestions keep the last list the app received.
- The file browser, diffs and branch operations need the node and fail meanwhile.

A node that was removed in Settings is different: its sessions take no new work until you move them to another node ([settings.md](settings.md) *Nodes*).

## Sources

A node works in the sources of projects on it, a source being a project's working copy on a node; it keeps no list of its own. Once the node is connected, put a project on it: add a project and choose the node, or open an existing project's settings and use **Add a source** with the node and the directory's path on that machine ([projects.md](projects.md)). The node checks that the directory exists. From a terminal, on that machine: `~/.reins/bin/reins source add <path> --project <id>` (a relative path is resolved where you run it); elsewhere, name the node with `--node <nodeId>` and give an absolute path. `reins source list` lists every project's sources, with their nodes (not those on removed nodes). **Settings → Nodes** shows how many sources each node holds.

## Uninstalling

1. `~/.reins/bin/reins node stop`
2. `rm -rf ~/.reins`
3. Remove the node in **Settings → Nodes** ([settings.md](settings.md) *Nodes*: sessions that ran on it stay readable, and can be moved to another node to continue).
