# Tech Debt

Tracked items for cleanup and improvement. Items are added as they're identified and removed when resolved.

## Backend

- `git.ts` is a bag of free functions that all take `projectDir` as their first argument. Refactor into a class (e.g. `GitRepo`) that accepts `projectDir` in the constructor so callers don't thread it through every call.
- `getChangedFiles()` and `getDiff()` duplicate the same git operations (committed diff, uncommitted diff, untracked files) with different output flags (`--numstat` vs `-U{n}`). Unify so `getChangedFiles` derives file summaries from the parsed diff output that `getDiff` already computes, eliminating the duplicated subprocess calls and merge logic.
- `sessions.ts` is too coupled to `ServerState`. It receives the full state object to access `state.sessions` and `state.clients`. Ideally it should receive narrow dependencies (e.g. the session map and a `Broadcast` function) rather than the entire server state bag, so it doesn't act as a conduit for threading `ServerState` into the rest of the bundle.

- `session_messages` tool results consume ~68% of DB size (42.5MB of 63MB message data). Currently only pruned on compaction, but most sessions never compact. Add a routine to prune tool result content from closed/merged task sessions where the full output is no longer needed for LLM context.

- WebSocket upgrade in `handler.ts` is an imperative `if` block, while all other routing is declarative via the router. Ideally the router would support `router.upgrade("/ws")` or similar, but `server.upgrade(req)` needs the Bun server object which the router doesn't have access to. Low priority — it's 3 lines and there's only one upgrade endpoint.

## WebSocket

- The frontend `onEvent` listener has the signature `(sessionId: string, event: any) => void`, designed for session events. Non-session broadcasts (e.g. `task_created`) are shoehorned through it with `sessionId: ""`. As more app-level broadcast types are added, this should be split into a separate listener channel (e.g. `onAppEvent`) or a more general message discriminator so the session-event path isn't overloaded.
- Broadcasting is ad-hoc: `createBroadcast(state.clients)` is called in multiple places (`wireSession`, `createNewSession`, `buildSessionOpts` for tools) each creating throwaway broadcast functions. There's no single layer that owns "outbound notifications" — session events, `task_updated`, and `session_created` are all broadcast from different call sites with different patterns. Should consolidate into a single broadcast service or event bus that all server-side code publishes to, making it easier to add new message types and reason about what gets sent when.

## Frontend

- `app.css` contains ~80 lines of `.hljs-*` token color rules for highlight.js, but highlight.js is no longer used anywhere. Markdown code blocks were migrated to Shiki (via `shared-highlighter.ts` in `markdown-content.ts`), making these dead CSS rules. Safe to delete.
- Several Lit components use manual `querySelector` instead of the idiomatic `@query` decorator (`app.ts`, `chat-panel.ts`, `task-form.ts`)
- Scroll active session into view in sidebar on navigation. Session buttons have `data-session-id` attributes ready. Attempted `scrollIntoView`, manual `scrollTo` on the overflow container, and `MutationObserver` for async data loading — none worked. Needs hands-on debugging in the browser to figure out what's blocking the scroll.
- `new CustomEvent(...)` calls are scattered across ~15 component files (`task-list.ts`, `task-list-item.ts`, `session-list-item.ts`, `assistant-session.ts`, `delegate-popover.ts`, `delete-task-dialog.ts`, `search-palette.ts`, `diff-hunk.ts`, `diff-file-tree.ts`, `file-viewer.ts`, `project-form.ts`, `task-detail.ts`). The new `events.ts` module centralizes event factories so renaming or reshaping events is a compile-time error at every call site. Move the remaining inline `CustomEvent` constructors into `events.ts` as typed factory functions.
- File type dispatch (image/PDF/markdown detection and renderer selection) is duplicated between `<file-viewer>` and `<diff-file-card>`. Adding a new previewable file type requires changes in both places. Ideally `<file-viewer>` would be decoupled from `FileBrowserStore` (accept plain props), and the diff card's preview tab would delegate to `<file-viewer>` for rendering. This would centralize the file type → renderer mapping so new types only need to be added once. Blocked on design questions: how the diff card fetches preview content on demand, and whether nested tab toggles (diff card's Diff/Preview containing markdown's Code/Preview) make sense.

- No frontend tests. The stores (`DiffStore`, `AppStore`, `ActiveProjectStore`) have coordination logic (polling, re-fetch triggers, session switching) that's entirely untested. At minimum, store-level tests with mocked fetch would catch regressions in when data is refreshed.
- Sessions are fetched eagerly — scratch sessions load in bulk via `ProjectStore.fetchLists()` when a project expands, and task sessions load via `fetchTaskSessions()` when a task expands. All session lists should be lazy-loaded (paginated or fetched on demand) since they're rarely browsed and will eventually become continuous conversations with lazy loading.

- Large diffs (e.g. unignored node_modules with 1.5M+ lines) grind the app to a halt. Multiple layers contribute: the diff API response is huge, parsing/processing it is slow, and the file tree renders thousands of DOM nodes. Mitigation ideas: (1) ETag/304 on diff responses so polling skips client-side work when nothing changed, (2) virtualize the file tree to only render visible nodes, (3) cap diff size with a summary fallback ("N files changed, diff too large to display"), (4) server-side pagination or streaming of diff data.

## Scripting / Execute Tool

- The `execute` tool uses Node.js `vm.createContext` for isolation, which prevents access to `process`, `import()`, `require`, filesystem, and network from agent-written scripts. This is adequate for preventing accidental misuse and casual prompt injection, but `vm` is **not a security boundary** — a determined attacker could potentially escape it. If the execute tool gains wider exposure (e.g. third-party plugins, untrusted input), upgrade to a child-process sandbox: spawn an isolated subprocess that communicates with the parent via IPC, with the API object proxied through an RPC bridge. See the planning doc at `docs/plans/completed/execute-and-search-tools.md` for a comparison of sandbox approaches.

- HTTP responses are not compressed. Bun's built-in server doesn't apply gzip/br automatically. Currently fine (largest JSON response is ~13KB for file listings), but will matter if payloads grow (e.g. large repos with thousands of files, or bulk API responses). Add response compression middleware or use Bun's `Bun.gzipSync` for JSON responses above a size threshold.

## Cross-cutting

- Frontend duplicates backend types (`ProjectInfo`, `SessionListItem`, `TaskListItem`, `SessionData` in `ws-client.ts`) and API path strings (hardcoded in stores). These can drift. Use TypeScript `paths` mapping (`"@backend/*": ["../backend/src/*"]`) so the frontend can `import type` directly from backend source files — `tsc` resolves them for type checking, `bun build` erases them completely. Runtime values like `API` path constants would need a zero-dependency shared file or stay duplicated.
