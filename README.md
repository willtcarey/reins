# REINS

**Remote Editing Interface for Nurturing Software** — a web-based workspace for managing your repos from anywhere.

Run the server alongside your projects, then connect from any browser or the optional Tauri desktop wrapper. Work happens through conversations with AI coding agents that can read, write, and execute code in your repos.

## How It Works

Add your git repos as projects, then use the assistant for general work or create tasks — focused units of work that each get their own branch. See [`docs/features/`](docs/features/) for more.

## Getting Started

You need an LLM API key (e.g. `ANTHROPIC_API_KEY`). See [Configuration](#configuration) for all options.

### Docker

```sh
docker build -t reins .

docker run -p 3100:3100 \
  -e ANTHROPIC_API_KEY=your-key \
  -v reins-data:/data \
  -v /path/to/your/repos:/repos \
  reins
```

The container runs the server and the local node as two supervised processes (see *Processes* below). The `-v reins-data:/data` mount persists both the server database and local-node session storage across container restarts. Add projects using their paths inside the container (e.g. `/repos/my-project`). See [docs/dev/docker.md](docs/dev/docker.md) for more options.

### Manual

Requires [Bun](https://bun.sh) (v1.0+) and Git.

```sh
bun install
bun run start        # builds the frontend, then runs the server and the node together
```

To keep it running in the background:

```sh
tmux new-session -d -s reins 'bun run start'
```

For the optional Tauri desktop wrapper, see [docs/dev/tauri.md](docs/dev/tauri.md).

### Processes

REINS runs as two local processes that talk over a private Unix socket (`~/.reins/run/node.sock`):

- the **server** (HTTP, WebSocket, the product database, credentials), and
- the **node**, which runs agent sessions against your checkouts and keeps their canonical storage in `~/.reins/node/storage.db`.

`bun run start` (and `bun run dev`) supervises both: it restarts the node if it crashes and stops both on Ctrl-C/SIGTERM. To run them separately, use `bun run start:server` and `bun run start:node` (in either order; the node keeps redialing until the server is up, and the server queues work until a node connects). Stopping the node with SIGTERM aborts any active agent runs cleanly. See [docs/dev/node-contract.md](docs/dev/node-contract.md) (*Process model*).

### Then

Open [http://localhost:3100](http://localhost:3100), add a project, and create a task or start a session.

## Architecture

| Package | Description | Docs |
|---|---|---|
| `packages/backend` | HTTP + WebSocket server, SQLite storage (session history and node replicas), git operations, node command outbox, process supervisor | [architecture](docs/dev/backend-architecture.md) |
| `packages/node` | Internal node: runs node-owned agent sessions in its own process, linked to the server over a local socket | [contract](docs/dev/node-contract.md) |
| `packages/frontend` | Lit + Tailwind CSS v4 SPA | [architecture](docs/dev/frontend-architecture.md) |
| `packages/tauri` | Optional Tauri v2 desktop wrapper that loads the backend URL without bundling frontend files | [setup](docs/dev/tauri.md) |

## Configuration

The only required environment variable is an API key for your LLM provider (e.g. `ANTHROPIC_API_KEY`). Everything else is optional.

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | API key for Anthropic models (required if using Anthropic) |
| `REINS_DATA_DIR` | `.reins/` (cwd) | Directory for the server SQLite database; the node's canonical storage lives separately at `~/.reins/node/storage.db` (both are under `/data` in Docker) |
| `REINS_PORT` | `3100` | Server port |
| `REINS_NODE_SOCKET` | `~/.reins/run/node.sock` | Unix socket between the server and the node; set it for both processes (the supervisor passes it to both) |
| `REINS_SECRET` | auto-generated | Hex-encoded 32-byte key for encrypting sensitive settings at rest |

The default model is configured in the app's settings UI and stored in the database. If no default model is configured, the server uses the pi SDK's built-in default. See [docs/features/settings.md](docs/features/settings.md).

## Development

```sh
bun run dev          # server with handler hot reload + node + supervised frontend JS/CSS watchers
bun run tauri        # launches the optional Tauri desktop wrapper
```

Server code changes (including the `@reins/node` code the server uses) hot-reload without interrupting the node's runs. Node code changes restart the node process once it has no active run. See [docs/dev/hot-reload.md](docs/dev/hot-reload.md).
