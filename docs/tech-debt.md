# Tech Debt

Tracked items for cleanup and improvement. Items are added as they're identified and removed when resolved.

## Backend

- `git.ts` is a bag of free functions that all take `projectDir` as their first argument. Refactor into a class (e.g. `GitRepo`) that accepts `projectDir` in the constructor so callers don't thread it through every call.
- `getChangedFiles()` and `getDiff()` duplicate the same git operations (committed diff, uncommitted diff, untracked files) with different output flags (`--numstat` vs `-U{n}`). Unify so `getChangedFiles` derives file summaries from the parsed diff output that `getDiff` already computes, eliminating the duplicated subprocess calls and merge logic.
- Widespread `as any` casts (~15 occurrences). Most are for smuggling `projectDir` through `RouteContext` (which doesn't have a typed slot for it) and for SDK type gaps (e.g. `getModel` provider arg, Bun `WebSocket` data). The tsconfig is `strict`, but these casts bypass it at every use site. Should type the route context properly and narrow the remaining casts.
- Business logic (git operations, validation, WS broadcasts) lives inline in route handlers. The `models/` layer introduced for tasks should be extended to projects and sessions so routes are thin HTTP adapters and the logic is reusable from tools, WS handlers, etc.
- `sessions.ts` is too coupled to `ServerState`. It receives the full state object to access `state.sessions`, `state.clients`, and `state.explicitModel`. Ideally it should receive narrow dependencies (e.g. the session map, a `Broadcast` function, model config) rather than the entire server state bag, so it doesn't act as a conduit for threading `ServerState` into the rest of the bundle.

## WebSocket

- The frontend `onEvent` listener has the signature `(sessionId: string, event: any) => void`, designed for session events. Non-session broadcasts (e.g. `task_created`) are shoehorned through it with `sessionId: ""`. As more app-level broadcast types are added, this should be split into a separate listener channel (e.g. `onAppEvent`) or a more general message discriminator so the session-event path isn't overloaded.

## Frontend

- Several Lit components use manual `querySelector` instead of the idiomatic `@query` decorator (`app.ts`, `chat-panel.ts`, `task-form.ts`)
- `diff-panel.ts` is doing too much — extract markdown preview/toggle into a `<diff-markdown-preview>` component and per-file diff card rendering into a `<diff-file-card>` component, leaving `diff-panel` as a thin layout shell
