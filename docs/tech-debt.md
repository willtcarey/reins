# Tech Debt

Tracked items for cleanup and improvement. Items are added as they're identified and removed when resolved.

## Backend

- `git.ts` is a bag of free functions that all take `projectDir` as their first argument. Refactor into a class (e.g. `GitRepo`) that accepts `projectDir` in the constructor so callers don't thread it through every call.
- `getChangedFiles()` and `getDiff()` duplicate the same git operations (committed diff, uncommitted diff, untracked files) with different output flags (`--numstat` vs `-U{n}`). Unify so `getChangedFiles` derives file summaries from the parsed diff output that `getDiff` already computes, eliminating the duplicated subprocess calls and merge logic.
- Widespread `as any` casts (~15 occurrences). Most are for smuggling `projectDir` through `RouteContext` (which doesn't have a typed slot for it) and for SDK type gaps (e.g. `getModel` provider arg, Bun `WebSocket` data). The tsconfig is `strict`, but these casts bypass it at every use site. Should type the route context properly and narrow the remaining casts.
- `sessions.ts` is too coupled to `ServerState`. It receives the full state object to access `state.sessions`, `state.clients`, and `state.explicitModel`. Ideally it should receive narrow dependencies (e.g. the session map, a `Broadcast` function, model config) rather than the entire server state bag, so it doesn't act as a conduit for threading `ServerState` into the rest of the bundle.

## WebSocket

- The frontend `onEvent` listener has the signature `(sessionId: string, event: any) => void`, designed for session events. Non-session broadcasts (e.g. `task_created`) are shoehorned through it with `sessionId: ""`. As more app-level broadcast types are added, this should be split into a separate listener channel (e.g. `onAppEvent`) or a more general message discriminator so the session-event path isn't overloaded.
- Broadcasting is ad-hoc: `createBroadcast(state.clients)` is called in multiple places (`wireSession`, `createNewSession`, `buildSessionOpts` for tools) each creating throwaway broadcast functions. There's no single layer that owns "outbound notifications" — session events, `task_updated`, and `session_created` are all broadcast from different call sites with different patterns. Should consolidate into a single broadcast service or event bus that all server-side code publishes to, making it easier to add new message types and reason about what gets sent when.

## Frontend

- Several Lit components use manual `querySelector` instead of the idiomatic `@query` decorator (`app.ts`, `chat-panel.ts`, `task-form.ts`)
- `diff-panel.ts` is doing too much — extract markdown preview/toggle into a `<diff-markdown-preview>` component and per-file diff card rendering into a `<diff-file-card>` component, leaving `diff-panel` as a thin layout shell
- `bun run dev` doesn't reliably rebuild Tailwind CSS when new utility classes are added. The JS watcher and Tailwind watcher run as separate processes, and Tailwind doesn't always pick up changes from the JS output. A full `bun run build` is needed to get new styles. Should investigate consolidating into a single build pipeline or ensuring the Tailwind watcher is triggered by source file changes.
- Scroll active session into view in sidebar on navigation. Session buttons have `data-session-id` attributes ready. Attempted `scrollIntoView`, manual `scrollTo` on the overflow container, and `MutationObserver` for async data loading — none worked. Needs hands-on debugging in the browser to figure out what's blocking the scroll.
- Auto-focus chat input on session navigation (e.g. from quick-open palette). Attempted in `chat-panel.ts` `updated()` hook with `requestAnimationFrame` and `updateComplete` + `setTimeout` — neither worked. Likely a focus-stealing issue with the palette overlay or Lit render timing. Needs investigation.
- No frontend tests. The stores (`DiffStore`, `AppStore`, `ActiveProjectStore`) have coordination logic (polling, re-fetch triggers, session switching) that's entirely untested. At minimum, store-level tests with mocked fetch would catch regressions in when data is refreshed.
- Sessions are fetched eagerly — scratch sessions load in bulk via `ProjectStore.fetchLists()` when a project expands, and task sessions load via `fetchTaskSessions()` when a task expands. All session lists should be lazy-loaded (paginated or fetched on demand) since they're rarely browsed and will eventually become continuous conversations with lazy loading.
