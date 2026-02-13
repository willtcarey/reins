# REINS

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
bun run --filter '@reins/frontend' dev  # starts frontend build watcher
```

## Build

```sh
bun run build        # builds frontend to packages/frontend/dist
```

## Backend

- **Adding API routes**: see [`packages/backend/docs/ROUTER.md`](packages/backend/docs/ROUTER.md)

## Architecture Decision Records

We keep ADRs in `docs/adr/` using the format `NNN-slug.md`. Offer to write an ADR when:

- A library, tool, or approach is **evaluated and rejected** — capture the findings so we don't repeat the research.
- A **significant architectural or dependency choice** is made — record the context and trade-offs.
- An existing decision is **revisited or reversed**.

See existing ADRs in [`docs/adr/`](docs/adr/) for the format to follow.

## Notes

- Use `bun` for all package management and script execution (not npm/yarn/pnpm).
- Backend runs directly on Bun — no separate build step needed.
- Frontend uses `bun build` for JS bundling and `@tailwindcss/cli` for CSS.
