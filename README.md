# REINS

**Remote Editing Interface for Nurturing Software** — a web-based workspace for managing your repos from anywhere.

Run the server alongside your projects, then connect from any browser or the native macOS app. Work happens through conversations with AI coding agents that can read, write, and execute code in your repos.

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

The `-v reins-data:/data` mount persists the database across container restarts. Add projects using their paths inside the container (e.g. `/repos/my-project`). See [docs/dev/docker.md](docs/dev/docker.md) for more options.

### Manual

Requires [Bun](https://bun.sh) (v1.0+) and Git.

```sh
bun install
bun run start
```

To keep the server running in the background:

```sh
tmux new-session -d -s reins 'bun run start'
```

For the macOS app, see [docs/dev/macos.md](docs/dev/macos.md).

### Then

Open [http://localhost:3100](http://localhost:3100), add a project, and create a task or start a session.

## Architecture

| Package | Description | Docs |
|---|---|---|
| `packages/backend` | HTTP + WebSocket server, SQLite storage, git operations, coding agent sessions | [architecture](docs/dev/backend-architecture.md) |
| `packages/frontend` | Lit + Tailwind CSS v4 SPA | [architecture](docs/dev/frontend-architecture.md) |
| `packages/macos` | Native macOS app (SwiftUI + WKWebView) | [setup](docs/dev/macos.md) |

## Configuration

The only required environment variable is an API key for your LLM provider (e.g. `ANTHROPIC_API_KEY`). Everything else is optional.

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | API key for Anthropic models (required if using Anthropic) |
| `REINS_DATA_DIR` | `.reins/` (cwd) | Directory for the SQLite database; set to a mounted volume path in Docker |
| `REINS_PORT` | `3100` | Server port |
| `REINS_SECRET` | auto-generated | Hex-encoded 32-byte key for encrypting sensitive settings at rest |

The default model is configured in the app's settings UI and stored in the database. If no default model is configured, the server uses the pi SDK's built-in default. See [docs/features/settings.md](docs/features/settings.md).

## Development

```sh
bun run dev          # starts backend + supervised frontend JS/CSS watchers
```
