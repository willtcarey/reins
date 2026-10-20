# Agent Conventions

See [README.md](README.md) for project overview, setup, and dev commands.

Before implementing code changes, read [docs/dev/workflow.md](docs/dev/workflow.md).
Comments say why, not what: don't match the comment density of the surrounding code ([code-style.md](docs/dev/code-style.md)).
Base branch: `master`.

## The running Reins

You may be running inside a Reins dev instance (`bun run dev`) serving this checkout. Your edits then reach it as follows ([hot-reload.md](docs/dev/hot-reload.md)):

- **Server code** (`packages/backend/src`) hot reloads on save.
- **Node code** (`packages/node`) does not. After changing it, reload the node with `await api.nodes.reload()` from `execute`, or `bun run node:reload`. It returns at once; your run pauses at its next request and continues on the new code. A build error is reported instead.
- **Process-owned code** (`packages/backend/src/process-owned.json`: `index.ts`, `server-process.ts`, `process-state.ts`, …) restarts the server process by itself on save, once the new code builds (a build error is logged and the server kept); the node keeps running, and so do its commands. Your run pauses, and the new process resumes it. `kill -HUP <server pid>` asks for the same restart by hand.
- **The supervisor** (`supervisor.ts`) and **`@reins/node-protocol`** need a full restart of `bun run dev` (after a protocol edit, process-owned edits stop restarting the server too, until that full restart). You cannot do that from inside it: tell the user.

Reloading picks up only the checkout the instance runs from, and affects every session on that node.

## Docs

These are your docs — update them as you work. Add new ones, revise stale ones, move completed plans.

| Location | What goes there |
|---|---|
| [`docs/dev/`](docs/dev/) ([index](docs/dev/INDEX.md)) | Developer guides — architecture, conventions, workflows. Read and follow relevant docs here for the area you're touching; these docs are instructions for you, not just background reference. Add new docs to the index. |
| [`docs/features/`](docs/features/) | Significant user-facing feature docs — how the user interacts, not implementation details. |
| [`docs/plans/`](docs/plans/) | Planning docs for features, refactors, architectural changes. Move to `completed/` when done. |
| [`docs/adr/`](docs/adr/) ([index](docs/adr/INDEX.md)) | Architecture Decision Records (`NNN-slug.md`). See index for when to write one. |
| [`docs/tech-debt.md`](docs/tech-debt.md) | Tech debt tracker. Suggest items to the user — only add once confirmed. |
| [`docs/TODO.md`](docs/TODO.md) | Roadmap and open items. |


