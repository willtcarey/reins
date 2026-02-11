# Herald

Bun monorepo with two packages:

- **`packages/backend`** — WebSocket server using `pi-coding-agent` SDK (Bun runtime)
- **`packages/frontend`** — Lit + Tailwind CSS v4 SPA, bundled with `bun build`

## Setup

```sh
bun install
```

## Development

```sh
bun run dev          # starts backend with --watch
bun run --filter '@herald/frontend' dev  # starts frontend build watcher
```

## Build

```sh
bun run build        # builds frontend to packages/frontend/dist
```

## Notes

- Use `bun` for all package management and script execution (not npm/yarn/pnpm).
- Backend runs directly on Bun — no separate build step needed.
- Frontend uses `bun build` for JS bundling and `@tailwindcss/cli` for CSS.
