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

## Dev Docs

Developer-facing guides (architecture, conventions, workflows) live in [`docs/dev/`](docs/dev/). See the [index](docs/dev/INDEX.md) for what's there. When adding a new dev doc, add an entry to the index.

## Architecture Decision Records

We keep ADRs in `docs/adr/` using the format `NNN-slug.md`. Offer to write an ADR when:

- A library, tool, or approach is **evaluated and rejected** — capture the findings so we don't repeat the research.
- A **significant architectural or dependency choice** is made — record the context and trade-offs.
- An existing decision is **revisited or reversed**.

See the [ADR index](docs/adr/INDEX.md) for existing decisions and the format to follow.

## Tech Debt

We track tech debt in [`docs/tech-debt.md`](docs/tech-debt.md). When you identify potential tech debt during a task, suggest it to the user — but only add it to the document once confirmed.

## TODO

Roadmap and open items live in [`docs/TODO.md`](docs/TODO.md).

## Feature Documentation

User-facing feature docs live in [`docs/features/`](docs/features/). When adding or changing a feature, update the relevant doc (or create a new one). These describe *how the user interacts with the feature* — not UI affordances or implementation details like what resets when, what labels appear, or how the system responds internally.

## Notes

- Use `bun` for all package management and script execution (not npm/yarn/pnpm).
- Backend runs directly on Bun — no separate build step needed.
- Frontend uses `bun build` for JS bundling and `@tailwindcss/cli` for CSS.
