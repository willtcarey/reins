# Tech Debt

Tracked items for cleanup and improvement. Items are added as they're identified and removed when resolved.

## Backend

- `getChangedFiles()` and `getDiff()` duplicate the same git operations (committed diff, uncommitted diff, untracked files) with different output flags (`--numstat` vs `-U{n}`). Unify so `getChangedFiles` derives file summaries from the parsed diff output that `getDiff` already computes, eliminating the duplicated subprocess calls and merge logic.
- Reins disables repository-configured Git textconv and external diff drivers for machine-readable diff endpoints. This avoids truncated patches when driver dependencies are unavailable, prevents transformed secrets from being exposed, and keeps parser input Git-native. Add deliberate diff-driver support later with an explicit trust/opt-in model, controlled execution environment, clear failure handling, and consistent file-list/patch semantics.
- `sessions.ts` is too coupled to `ServerState`. It receives the full state object to access `state.clients`. Ideally it should receive narrow dependencies (e.g. a `Broadcast` function) rather than the entire server state bag, so it doesn't act as a conduit for threading `ServerState` into the rest of the bundle.

- `session_messages` tool results consume ~68% of DB size (42.5MB of 63MB message data). Currently only pruned on compaction, but most sessions never compact. Add a routine to prune tool result content from closed/merged task sessions where the full output is no longer needed for LLM context.

- WebSocket upgrade in `handler.ts` is an imperative `if` block, while all other routing is declarative via the router. Ideally the router would support `router.upgrade("/ws")` or similar, but `server.upgrade(req)` needs the Bun server object which the router doesn't have access to. Low priority — it's 3 lines and there's only one upgrade endpoint.


## WebSocket

- Broadcasting is ad-hoc: `createBroadcast(state.clients)` is called in multiple places (`wireSession`, `createNewSession`, `buildSessionOpts` for tools) each creating throwaway broadcast functions. There's no single layer that owns "outbound notifications" — session events, `task_updated`, and `session_created` are all broadcast from different call sites with different patterns. Should consolidate into a single broadcast service or event bus that all server-side code publishes to, making it easier to add new message types and reason about what gets sent when.

## Frontend

- `app.css` contains ~80 lines of `.hljs-*` token color rules for highlight.js, but highlight.js is no longer used anywhere. Markdown code blocks were migrated to Shiki (via `shared-highlighter.ts` in `markdown-content.ts`), making these dead CSS rules. Safe to delete.
- Several Lit components use manual `querySelector` instead of the idiomatic `@query` decorator (`app.ts`, `chat-panel.ts`, `task-form.ts`)
- Scroll active session into view in sidebar on navigation. Session buttons have `data-session-id` attributes ready. Attempted `scrollIntoView`, manual `scrollTo` on the overflow container, and `MutationObserver` for async data loading — none worked. Needs hands-on debugging in the browser to figure out what's blocking the scroll.
- No frontend tests. The stores (`DiffStore`, `AppStore`, `ActiveProjectStore`) have coordination logic (polling, re-fetch triggers, session switching) that's entirely untested. At minimum, store-level tests with mocked fetch would catch regressions in when data is refreshed.
- Sessions are fetched eagerly — scratch sessions load in bulk via `ProjectStore.fetchLists()` when a project expands, and task sessions load via `fetchTaskSessions()` when a task expands. All session lists should be lazy-loaded (paginated or fetched on demand) since they're rarely browsed and will eventually become continuous conversations with lazy loading.

- Large diffs (e.g. unignored node_modules with 1.5M+ lines) can still overwhelm transport, parsing, and the non-virtualized file tree. Per-file diff rendering is now capped at 10,000 additions plus removals in Changes, which prevents oversized files from scheduling row rendering/highlighting while retaining their headers and actions. Remaining mitigation ideas: (1) ETag/304 on diff responses so polling skips client-side work when nothing changed, (2) virtualize the file tree to only render visible nodes, (3) add an aggregate payload cap with a summary fallback, (4) omit blocked file bodies server-side or add pagination/streaming.

## Scripting / Execute Tool

- The `execute` tool uses Node.js `vm.createContext` for isolation, which prevents access to `process`, `import()`, `require`, filesystem, and network from agent-written scripts. This is adequate for preventing accidental misuse and casual prompt injection, but `vm` is **not a security boundary** — a determined attacker could potentially escape it. If the execute tool gains wider exposure (e.g. third-party plugins, untrusted input), upgrade to a child-process sandbox: spawn an isolated subprocess that communicates with the parent via IPC, with the API object proxied through an RPC bridge. See the planning doc at `docs/plans/completed/execute-and-search-tools.md` for a comparison of sandbox approaches.

- HTTP responses are not compressed. Bun's built-in server doesn't apply gzip/br automatically. Currently fine (largest JSON response is ~13KB for file listings), but will matter if payloads grow (e.g. large repos with thousands of files, or bulk API responses). Add response compression middleware or use Bun's `Bun.gzipSync` for JSON responses above a size threshold.

## Tests

- A few backend test files are still named by concept rather than mirroring a source module: `routes/session-activity.test.ts`, `routes/session-model-route.test.ts`, `routes/auth-api-keys.test.ts`, `routes/static.test.ts`, `scripting/sessions-set-model.test.ts` and `canonical-message-readers.test.ts`. Fold each into the test file of the module it exercises (see [testing-structure.md](dev/testing-structure.md)). The node and session modules already mirror `src/`; `__tests__/integration/` and `models/node-dependency-boundary.test.ts` are deliberate exceptions.
