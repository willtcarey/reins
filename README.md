# REINS

**Remote Editing Interface for Nurturing Software** — a web-based workspace for managing your repos from anywhere.

Run the server alongside your projects, then connect from any browser or the native macOS app.

## Packages

Bun monorepo with three packages:

- **`packages/backend`** — HTTP + WebSocket server using `pi-coding-agent` SDK (Bun runtime). REST API, SQLite storage, git operations, and coding agent session management.
- **`packages/frontend`** — Lit + Tailwind CSS v4 SPA, bundled with `bun build`
- **`packages/macos`** — Native macOS app (SwiftUI + WKWebView) that wraps the frontend

## Setup

```sh
bun install
```

## Development

```sh
bun run dev          # starts backend with --watch
bun run --filter '@reins/frontend' dev  # starts frontend build watcher
```

## Build

```sh
bun run build        # builds frontend to packages/frontend/dist
```

## Test

```sh
bun run --filter '@reins/backend' test
```

## Notes

- Use `bun` for all package management and script execution (not npm/yarn/pnpm).
- Backend runs directly on Bun — no separate build step needed.
- Frontend uses `bun build` for JS bundling and `@tailwindcss/cli` for CSS.
- See [docs/dev/macos.md](docs/dev/macos.md) for building and running the macOS app.
