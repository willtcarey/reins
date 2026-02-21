# Tech Debt

Tracked items for cleanup and improvement. Items are added as they're identified and removed when resolved.

## Backend

- `git.ts` is a bag of free functions that all take `projectDir` as their first argument. Refactor into a class (e.g. `GitRepo`) that accepts `projectDir` in the constructor so callers don't thread it through every call.
- `getChangedFiles()` and `getDiff()` duplicate the same git operations (committed diff, uncommitted diff, untracked files) with different output flags (`--numstat` vs `-U{n}`). Unify so `getChangedFiles` derives file summaries from the parsed diff output that `getDiff` already computes, eliminating the duplicated subprocess calls and merge logic.
- Widespread `as any` casts (~15 occurrences). Most are for smuggling `projectDir` through `RouteContext` (which doesn't have a typed slot for it) and for SDK type gaps (e.g. `getModel` provider arg, Bun `WebSocket` data). The tsconfig is `strict`, but these casts bypass it at every use site. Should type the route context properly and narrow the remaining casts.
- Business logic (git operations, validation, WS broadcasts) lives inline in route handlers. The `models/` layer introduced for tasks should be extended to projects and sessions so routes are thin HTTP adapters and the logic is reusable from tools, WS handlers, etc.

## Frontend

- Several Lit components use manual `querySelector` instead of the idiomatic `@query` decorator (`app.ts`, `chat-panel.ts`, `task-form.ts`)
- `diff-panel.ts` is doing too much — extract markdown preview/toggle into a `<diff-markdown-preview>` component and per-file diff card rendering into a `<diff-file-card>` component, leaving `diff-panel` as a thin layout shell
