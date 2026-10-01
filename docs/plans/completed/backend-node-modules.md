# Deeper backend modules around the node link

Status: **done.** The modules it built are described in [backend-architecture.md](../../dev/backend-architecture.md), [node-contract.md](../../dev/node-contract.md) and [hot-reload.md](../../dev/hot-reload.md); paths below are as they were before the directory moves (`src/node-link/`, `src/nodes/`, `src/sessions/`, `src/pi/`).

The server's node code (`packages/backend/src/runtimes/`, the outbox and `node-transport/`) is tight per file, but its concepts are spread across files so callers must know how the pieces fit. This plan reshapes it into fewer, deeper modules. Behaviour and the wire protocol do not change.

Vocabulary: see the `codebase-design` skill (module, interface, depth, seam, adapter).

## Lanes

The work runs as two parallel lanes in one checkout. Each lane owns its files; touch the other lane's files only as noted, and commit with explicit paths (`git add <paths>`), never `git add -A`. Rebase-free: both lanes commit to the task branch in turn. A full-suite failure caused by the other lane's uncommitted work is not yours to fix; re-run once it settles.

### Lane A: node link (steps A1, A2)

Owns: `dev-build.ts`, `node-transport/*`, `runtimes/node-hub.ts`, `runtimes/node-services.ts`, `runtimes/node-server-handlers.ts`, `runtimes/node-credentials.ts`, `runtimes/node-tool-calls.ts`, `runtimes/node-source.ts`, `models/node-command-notifications.ts`, `state.ts` (`NodeHub`), `server-process.ts`, `server.ts`, new `runtimes/node-storage.ts`, their tests, `docs/dev/hot-reload.md`, `docs/dev/node-contract.md`.

**A1. Process-owned boundary.** Process-owned code (never hot reloads; `RESTART_REQUIRED_SOURCES` in `dev-build.ts`) currently imports reloadable modules, which then get a stale process-lifetime copy: `node-transport/commands.ts` → `runtimes/node-source.ts` (→ `task-store`, `settings-store`, `node-store`), `node-command-store.ts` → `pi-session-store.ts`, `session-store.ts` → `models/skill.ts`. So in dev, edits to `sessionTarget`/`laneSeed` reload for routes but not for delivery.
- Add a test that the static import closure of `RESTART_REQUIRED_SOURCES` stays inside that set (plus `migrations.ts`, which only runs at startup, and type-only imports).
- Make `deliverToNode` reloadable: the hub already receives it through `services.deliver`; move `NodeCommandTimeouts`/`NODE_COMMAND_TIMEOUTS`/`NodeLinks`/`NodeCommandClient` to process-owned code (e.g. `node-hub.ts` or `state.ts`) and drop `node-transport/commands.ts` from the set.
- Fix the other two leaks (move the needed type/function or add the dependency to the set, whichever is honest about who owns it).
- Consider making submission-failure notification (`onCommandDelivered`) reloadable via the services port; do it if it falls out cheaply.

**A2. Narrow hub port; one handlers module.** `NodeHubServices extends NodeServerServices` gives the hub 15 methods; it uses 4. The spread and self-reference in `node-services.ts` exist only to feed `nodeServerHandlers`, a seam with one adapter.
- Hub port becomes `{ handlers(nodeId), recover(nodeId, liveSessions), route(sessionId), deliver }`. `route` resolves the session's node once (today `available` and `send` resolve it separately); shape it so the dispatcher's availability check and delivery share it.
- Merge `node-services.ts` and `node-server-handlers.ts`: one module builds a node's fenced handlers and calls product modules directly (no `NodeServerServices` bag).
- Move `readPiStorage`, `wireValue`, `refusedByPi` into `runtimes/node-storage.ts` (the server half of `RemoteStorage`).
- Keep `createNodeCredentialService`'s injected store/resolver (a real seam: tests supply other adapters).
- Coordinate with lane B: A2 consumes `nodeSessionReports`/`settleInterruptedRuns`, which lane B's B2 reshapes. Do A2 after B2 has landed (check `git log`), or ask the orchestrator.

### Lane B: sessions (steps B1, B2, B3)

Owns: `runtimes/node-execution.ts`, `node-command-store.ts`, `node-command-recovery.ts`, `models/node-command-dispatcher.ts`, `models/node-command-delivery.ts`, `runtimes/session-instance.ts`, `runtimes/session-manager.ts`, `runtimes/node-session-events.ts`, `session-runs.ts`, `models/node-session-activity.ts`, `models/session-ownership.ts`, and the callers `ws.ts`, `routes/sessions.ts`, `routes/project-sessions.ts`, `routes/task-sessions.ts`, `models/sessions.ts`, `models/code-review-submission.ts`, `scripting/*`, their tests, `docs/dev/backend-architecture.md`, `docs/dev/node-runtime.md`. Lane A's A1 may touch `node-command-store.ts`'s `pi-session-store` import; keep that edit if you see it.

**B1. Submission wakes the dispatcher itself.** Every caller now enqueues, lets its transaction commit, then calls `state.nodes.wake()` (`node-execution.ts`, `session-instance.ts`, `code-review-submission.ts`, `models/sessions.ts` via `enqueueSetModel`).
- One submission module: `submit(nodes, sessionId, command)` with typed commands (prompt/steer with content, clientId, sourceSessionId?; setModel), and `control(nodes, sessionId, "abort" | "resumePending")`. `submit` validates the session's source, inserts, and schedules `queueMicrotask(() => void nodes.wake())`. bun:sqlite transactions are synchronous, so the wake runs after an enclosing transaction commits; after a rollback it is an empty scan. Test that.
- Replace `executeSessionCommand`'s optional `content?`/`clientId?` + runtime check with the typed commands.
- No outbox SQL outside the outbox store: `session-ownership.ts` and `node-session-activity.ts` call store functions (e.g. `hasPendingWork(sessionId)`).
- Fold `models/node-command-delivery.ts` into the dispatcher (only it uses it). Note: dispatcher, delivery and store are process-owned; keep `RESTART_REQUIRED_SOURCES` accurate (lane A owns `dev-build.ts`: tell the orchestrator if the set must change).

**B2. One run-lifecycle module.** "A session's run" is spread over `session-runs.ts`, `SessionInstance.started/settled/...`, `node-session-events.ts`, `models/node-session-activity.ts`, `SessionInstance.waitForNodeSettlement` and `session-ownership.ts`'s idle check. The settlement caller reads the child reply and passes `reply`/`replyError` as data.
- New `runtimes/session-runs.ts` (or merged into the existing `session-runs.ts`), given `{ broadcast, nodes }`: `runStarted(sessionId, runId)`, `runSettled(report)` (reads a child's final reply itself), `settleInterruptedRuns(nodeId, liveSessions)`, `activity(row)`, `waitForSettlement(sessionId, timeoutMs, signal)`.
- `RunSettlementFacts`, `RuntimeRunOutcome` and `SessionInstanceHost` leave the interfaces. `SessionInstance` keeps only the caller-scoped scripting API (start/send/wait, scope, child depth). `node-session-events.ts` keeps only the live event relay (or disappears if trivial).
- Keep `nodeSessionReports(state)`'s exported shape (`event`, `started`, `settled`) and `settleInterruptedRuns(reports, nodeId, live)` usable by `node-services.ts` until lane A's A2 lands, or update `node-services.ts` minimally yourself and say so in the commit.

**B3. Delete `SessionManager`.** A pass-through: replace with `createSession(state, projectId, opts)` and `new SessionInstance(state, callerId)`; drop `createNewSession`. Deduplicate the `default_model` Pi-runtime check (`session-manager.ts` and `node-source.ts` `laneSeed`) into one helper in `models/model-settings.ts` (`node-source.ts` is lane A's: make the one-line call-site change and mention it).

## After both lanes

Directory moves (pure renames, one commit): `src/node-link/` (process-owned: hub, peer, socket, dispatcher, outbox store, recovery), `src/nodes/` (reloadable node handlers, storage, credentials, delivery, tool calls, event relay), `src/sessions/` (create, orchestration, runs, ownership), `src/pi/` (`runtimes/pi/` + `registry.ts`). `RESTART_REQUIRED_SOURCES` becomes a directory prefix plus the few shared stores. Tests mirror the new folders (`testing-structure.md`). Then move this plan to `completed/`.

## Done when

Each step: `bun run test`, `bun run typecheck`, `bun run lint` pass; dev docs describe the new modules (`backend-architecture.md`, `node-contract.md`, `hot-reload.md` as relevant); one commit per step.
