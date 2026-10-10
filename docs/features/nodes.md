# Nodes

A **node** is a machine that runs Reins sessions: the agent's tools, its checkouts and its model calls run there, while the Reins server keeps the sessions, settings and credentials and serves the web app. Reins runs one node beside the server (the **local** node). You can add others: another computer, a VM, a cloud machine. Each one needs network access to the Reins server, `curl`, `sh`, `git` and `bash`. Nodes run on Linux and macOS.

## Installing a node

In **Settings → Nodes**, click **Add node** ([settings.md](settings.md) *Nodes*). The page shows a one-line command with a pairing code. Run it on the machine you are adding:

```sh
curl -fsSL https://reins.example.ts.net/nodes/install | sh -s -- <code>
```

To have the node serve checkouts on that machine right away, append `--source <path>` for each:

```sh
curl -fsSL https://reins.example.ts.net/nodes/install | sh -s -- <code> --source ~/src/app --source ~/src/site
```

The command:

1. downloads Bun (the version the server runs) from Bun's GitHub releases, unless it is already there, and the server's node code, checking the download against its checksum;
2. pairs the machine with the server using the code;
3. declares the checkouts given with `--source`;
4. starts the node in the background and waits until it connects.

Its last line says what happened: `Node "<name>" (<id>) connected to <server>` when it worked, or what failed and where to look. It exits non-zero on failure. The settings page shows the node as connected at the same time.

The pairing code works once and expires after 10 minutes. It goes to the server only as part of the pairing request, never in a URL, and is never printed or logged.

**Running it again** is safe, with the same command and the same (now used) code: a machine already paired with this server is not paired again, checkouts already declared stay declared, and a node already running is left running. Run it again to restart a node that stopped, or to add `--source` checkouts. If the server's node code changed since, it installs the new code and restarts the node on it.

A machine already paired with another Reins server is refused (exit 3), without using the code. To move it to this server, run `~/.reins/bin/reins node pair --force <server URL> <code>`, then the install command again.

## What it installs

Everything goes in `~/.reins` (or the directory named by `REINS_NODE_DATA_DIR`), readable only by you:

| Path | What |
|---|---|
| `bun` | Bun, the runtime the node runs on |
| `builds/<build>/` | The node's code (`reins.js`) and the Reins feature docs that come with it |
| `current` | The build in use |
| `bin/reins` | The `reins` command for this node |
| `node.json`, `keys/` | The pairing: the server, the node's ID, its declared checkouts and its private key |
| `logs/node.log` | The node's output |
| `run/node-status.json` | Whether the node runs, and whether it is connected |

Nothing is installed outside it. To use `reins` without its path, add `~/.reins/bin` to your `PATH`.

## Running the node

The node runs in the background until you stop it, the machine restarts or the server refuses it. It is not a system service: after a restart, start it again.

- `~/.reins/bin/reins node start` starts it in the background and waits until it connects.
- `~/.reins/bin/reins node stop` stops it. Its sessions' runs pause; the server resumes them when the node next connects.
- `~/.reins/bin/reins node status` shows the server it is paired with, its node ID, its checkouts, the build it runs, its log and, on the last line, whether it is running and connected. It exits 0 when the node is connected, 3 when it is not running and 4 when it is running but not connected.
- `~/.reins/bin/reins node run` runs it in the foreground instead, logging to the terminal, until Ctrl-C.

While it runs, the node reconnects by itself whenever the server restarts or the network drops. If the server refuses it (the node was removed or revoked in Settings), it stops, and `status` says so.

Its output is appended to `~/.reins/logs/node.log`.

## Checkouts

A node works only in the checkouts declared on its machine. Besides `--source` at install:

- `~/.reins/bin/reins node source add <path>` declares one (an existing directory);
- `~/.reins/bin/reins node source remove <path>` stops serving one;
- `~/.reins/bin/reins node source list` lists them.

A running node reports a change to the server within moments. Then attach the checkout to a project in **Settings → Nodes** ([settings.md](settings.md) *Sources*).

## Uninstalling

1. `~/.reins/bin/reins node stop`
2. `rm -rf ~/.reins`
3. Remove the node in **Settings → Nodes** ([settings.md](settings.md) *Nodes*: a node whose checkouts belong to projects cannot be removed).
