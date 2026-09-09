# Asynchronous session orchestration

## Inspection

`delegate` currently awaits a fresh task session under a project mutex, propagates abort, extracts the last assistant text, then closes the runtime. `api.sessions` exposes DB reads and model changes but no execution operations. Session creation/reopen and transcript observers already live in `runtimes/sessions-manager.ts`. Pi prompt settlement includes compaction/retry beyond `agent_end`; Claude SDK rejects native steering. Session titles are `sessions.name`; absent names retain existing first-message display behavior.

## Focused plan

- Replace the registered blocking delegate tool with discoverable `api.sessions.start`, `send`, and `wait`; retain historical transcript rendering.
- Start creates a session in the caller's project/task (same checkout), with required `parentSessionId: "current" | null` semantics and optional title/model/thinking overrides. No cross-task checkout orchestration. Child depth remains bounded. Independent sessions have no parent. Return after materialization and admission, not prompt completion.
- Runtime adapters remain the execution source of truth; no managed-session execution wrapper/state machine. Extend `AgentRuntime` with `queue(content)` (admission, starts idle runtimes) and `waitForIdle()` (all-settled). Pi uses native `followUp`, `waitForIdle`, and `isIdle`; retain actual prompt/preflight promises across its async preflight and final-settlement gaps. Claude extends its existing prompt completion machinery with pending input messages. Native steering joins active work; idle delivery starts a turn for either mode. No cancellation/restart fallback.
- Per user clarification, there are **no run receipts or database schema changes**. `wait(sessionId)` waits for the whole session to settle, including all queued follow-ups and native steering, then returns the latest outcome. Timeout is bounded and cancellation affects only the waiter. Live failures/cancellation are retrieved from runtime completion/transcript state; after eviction/restart, waiting reads the persisted transcript without claiming to recover transient execution errors. Queued work is not replayed after restart.
- Extend execute context with session creation/open capabilities and its abort signal. Keep scripting as validation/access/schema glue; lifecycle behavior belongs below it.
- Preserve runtime observers and naming defaults. Retain idle runtime lifecycle instead of closing children on completion. Shared checkout means concurrent agents must coordinate file edits; no project-wide lock held across nested waits.

## Validation

Red-green-refactor at the runtime adapter and scripting boundaries: nonblocking response execution, native queued follow-ups, wait-until-all-settled, native steering/rejection, idle steering, already-settled and persisted transcript results, failures/cancellation/timeout, waiter cancellation isolation, explicit parent/title behavior and scope validation. Run full tests, typecheck and lint; update runtime and feature docs.

## Completion

Implemented using native runtime queues/completion, with no extra execution wrapper or database schema. Removed the registered blocking delegate tool while retaining historical transcript rendering. Added scripting-boundary coverage for parent/title/default naming, task scope/depth, concurrent reopen and sibling creation without redundant checkouts, whole-session waits, persisted history, bounded timeout, and cancellation isolation; adapter tests cover native queues, Pi preflight/final-settlement gaps, and Claude failure/abort/unsupported steering.

Validation: `bun test` (1,487 passing), `bun run typecheck`, `bun run lint` (zero warnings/errors), and `git diff --check` all passed. Developer/runtime/persistence and feature docs updated. No live provider calls were needed; native SDK/subprocess boundaries are stubbed in tests.

## Non-goals

Automatic parent result injection/wakeup, persistent workspaces, plugins, cross-project/task worker scheduling, automatic replay of interrupted runs, or new frontend orchestration controls.
