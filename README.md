# REINS

**Remote Editing Interface for Nurturing Software** — a web-based workspace for managing your repos from anywhere.

Run the server alongside your projects, then connect from any browser or the native macOS app.

## Requirements

- [Bun](https://bun.sh) (v1.0+)
- Git
- An LLM API key — set `ANTHROPIC_API_KEY` in your environment (other providers work too; see [Configuration](#configuration))

## Getting Started

```sh
# Install dependencies
bun install

# Build the frontend
bun run build

# Start the server
bun packages/backend/src/index.ts
```

Open [http://localhost:3100](http://localhost:3100) in your browser. Add a project by pointing it at a local git repo, then create a task or start a session.

To keep the server running in the background, start it in a tmux session:

```sh
tmux new-session -d -s reins 'bun packages/backend/src/index.ts'
```

## Configuration

The only required environment variable is an API key for your LLM provider (e.g. `ANTHROPIC_API_KEY`). Everything else is optional.

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | API key for Anthropic models (required if using Anthropic) |
| `REINS_PORT` | `3100` | Server port |
| `REINS_PROVIDER` | — | Override LLM provider (e.g. `anthropic`, `openai`) |
| `REINS_MODEL` | — | Override model ID (e.g. `claude-sonnet-4-20250514`) |

`REINS_PROVIDER` and `REINS_MODEL` must be set together. When omitted, the server uses the default model from the pi-coding-agent SDK.

## Development

```sh
bun run dev          # starts backend + frontend build watcher
```

## Packages

- **`packages/backend`** — HTTP + WebSocket server using `pi-coding-agent` SDK (Bun runtime). REST API, SQLite storage, git operations, and coding agent session management.
- **`packages/frontend`** — Lit + Tailwind CSS v4 SPA, bundled with `bun build`
- **`packages/macos`** — Native macOS app (SwiftUI + WKWebView) that wraps the frontend. See [docs/dev/macos.md](docs/dev/macos.md).
