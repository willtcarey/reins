# Session run state from Pi

Status: **in progress** (investigation 2026-10-14; revised 2026-10-17: the session store derives "running" from the process's live state, and recovery is kept to what removing the row's copy requires). Steps 1 and 2 are done (*Steps*).

Since ADR-029, Pi's storage and the runtime that drives it are both in the server process. Reins still keeps its own copy of each run on the `sessions` row: `run_id`, `run_started_at`, `activity_state = 'running'`, `settlement_count`, `settlement_json` and `settlement_next_seq`. The runtime's lifecycle reports keep that copy in step (`lifecycleReports` in `session-runtime/build.ts` calls `runStarted`/`runSettled` in `sessions/session-runs.ts`). Recovery and `interruptRunsOn` patch it when it drifts (`settleAsInterrupted`).

This plan works out how much of that copy can come from Pi's durable state plus the live runtime, and what has to stay.

**Short answer:** "Is it running?" should become a question about the live runtime alone. Runs now exist only in this process, and Pi's storage cannot tell a run being driven from a run cut off by a crash. Pi's durable state takes over three jobs:
- "is there unfinished work" (recovery and the Resume button);
- "how did the last run end";
- "is this input still waiting for a run".

The row keeps three things Pi cannot hold: the unread flag, the resume budget, and one record of the last run end as Reins applied it, now carrying Pi's operation ID. `run_id`, `run_started_at`, `settlement_count`, `settlement_next_seq` and the `'running'` value go. Recommendation: do it, in the staged order under *Steps*.

**The app keeps its running flag.** The session store still returns `activity_state` with its three values (`running`, `finished`, null). It derives `running` from the process's open sessions (`process.sessions`) at read time, which each app hands the stores at its start along with the database (`setDb`). So the domain types coming out of the store, and the code that reads them, do not change; only the few SQL queries that filter on `'running'` do (§4 *The session store*).

**Recovery stays as small as it is today.** It changes only where it must, because the row's `'running'` goes: it finds pending runs from Pi's lane state instead, and records a give-up. Catching up lost run ends and starting stranded steers are possible improvements, listed under *Later*, not part of this plan's steps.

## 1. What Pi 0.85 stores about runs and operations

All of it is in `pi_values` (one row per `(session_id, namespace, key)`, JSON in `value_json`), written by `PiStorageAdapter`. Paths below are under `node_modules/@earendil-works/pi-agent-core/dist/harness/`. The address helpers are in `session/values.js:62-80` and the types in `session/types.d.ts`.

| Namespace / key | Shape | Lifetime |
|---|---|---|
| `pi.lane.state` / `main` | `LaneState {currentOperationId: string \| null, lastOperationId: string \| null, inbox: InboxItem[]}` (`types.d.ts:286-290`). `InboxItem {entryId, kind: "steer"\|"followUp"\|"nextRun"\|"write"}` (`types.d.ts:116-120`). | Created with the lane (`runtime/harness.js:96-112`, all null/empty). Rewritten by every operation start, every queue change and every terminal commit. |
| `pi.op.meta` / `<operationId>` | `OperationMeta {operationId, lane, sourceTipId, startedAt (ms), intent}`. `intent` is `{kind: "run", promptEntryIds}`, `{kind: "compaction", customInstructions?}` or `{kind: "navigation", targetId, summarize, label?, customInstructions?}` (`types.d.ts:62-80`). | Written when the operation is accepted (`runtime/lane.js:436-465` for a run, `532-539` for a compaction). Deleted by its terminal commit (`runtime/drive/terminal.js:4-31`). |
| `pi.op.state` / `<operationId>` | `OperationState`: one of 13 leaves by `at` (`starting`, `checkpoint`, `assistant.ready/effect_pending/retry_wait`, `tools`, `deferred.suspended/effect_pending`, `summary.*`, `navigation.ready_to_commit`), each with `control: {status: "running"} \| {status: "cancel_requested", requestedAt}` (`types.d.ts:81-86, 225-278`). | Rewritten at each step (`lane.js:247-270`). Deleted at the terminal commit. |
| `pi.op.tool_args`, `pi.op.tool_memo`, `pi.op.preparation` / `<operationId>:…`; `pi.pending.tool_output`, list `pi.pending.assistant_frame` | Scratch state for one operation (bash's `exec` memo lives here). | Deleted at the terminal commit (`terminal.js:22-31`). |
| `pi.result` / `<operationId>` | `OperationResultRecord {operationId, kind, status: "completed"\|"declined"\|"aborted"\|"failed", error?: {code, message, details?}, fromTipId, tipId, startedAt, endedAt}` (`types.d.ts:92-103`, built by `terminal.js:34-48`). `error` is present exactly when `failed`. `declined` occurs only for compaction and navigation. | Written by the terminal commit and **never deleted**: one per finished operation, so it is the session's complete operation history. Left out of forks (`session/fork-policy.js:12`). |
| `pi.pending.entry` / `<entryId>` | `PendingEntry {type: "message", payload}`: a queued steer's message (`lane.js:1156`). | Moved into the transcript when an operation captures it (`lane.js:404-461`). Deleted with it, or discarded by an abort (`lane.js:799-830`). |
| `pi.branch.tip` / `main`, `pi.lane.config` / `main` | The tip entry ID; `LaneConfiguration {model, thinkingLevel, activeToolNames}` (`types.d.ts:54-61`). | — |

**The terminal commit is atomic.** `settleOperation`'s `finish` (`lane.js:272-291`) commits all of these in one storage commit, which `PiStorageAdapter` makes one SQLite transaction:
- the operation's own writes;
- `pi.result[op]`;
- `pi.lane.state` with `currentOperationId: null` and `lastOperationId: op`;
- the cleanup, which deletes `op.meta`, `op.state` and the scratch values.

`run_end` is emitted only after that commit. So from storage, "operation X ended, and how" is either fully present or absent.

**Identity.** A run's `runId` in every event is its `operationId` (`run_start` at `lane.js:470`). A compaction inside a run (threshold or overflow) is part of the run, not an operation of its own. Its `compaction_start` carries the run's ID (`drive/response.js:326`, `drive/checkpoint.js:100`). A standalone compaction or navigation is its own operation, with its own result. Its end emits `compaction_end`/`navigation_end`, never `run_end` (`drive/reconcile.js:61-80`). `run_resume` is emitted only when a deferred provider response resumes (`drive/deferred.js:98`), never on crash recovery.

**What an interrupted operation looks like.** It is the same as one being driven right now:
- `currentOperationId` is set;
- `op.meta` and `op.state` are present, possibly `cancel_requested`;
- there is no result.

`AgentHarness.create` reports it as `open` (`runtime/harness.js:291-305`; its `kind` is `run`/`compaction`/`navigation`), and the lane restores it passively (`runtime/restore.js:86-116`). **Nothing durable says whether anyone is driving it**: only the process knows. ("Suspended" in Pi's own vocabulary is something else: `deferred.suspended`/`run_suspend`, a run polling a deferred provider response.)

**Queued steering** on an idle lane is an inbox item plus a `pi.pending.entry`, with `currentOperationId: null` (`lane.js:1146-1162`). It waits there until something calls `accept` (the runtime's `startQueuedSteeringWhenIdle`). Nothing starts it after a crash.

**A faulted harness** (a storage error) leaves its operation current with no result: Pi never ends it.

### Stable API or internal format

- **Stable harness API** (`agent-harness.d.ts`, `AgentLane`). These need a live harness, so they serve the live runtime, not list queries or recovery before a runtime opens:
  - `inspectExecution()` returns `{current: {id, kind, startedAt, status} | null, lastOperationId, tipId}`;
  - `getResult(operationId)` returns the `OperationResultRecord`;
  - `watch()` gives a snapshot with `lastResult` and `queues`;
  - `waitForIdle()`;
  - the `run_end` event payload (`status`, `error`, `fromTipId`, `tipId`).
- **Published storage contract.** The package root exports these, typed: the address helpers (`laneState`, `operationResult`, `operationMeta`, `pendingEntry`) and the types (`LaneState`, `OperationMeta`, `OperationResultRecord`) (`index.d.ts:14` re-exports `harness/session/index.ts`, which re-exports `values.ts` and `types.ts`). They exist for `Storage` implementers such as Reins. Reading them with SQL is reading Pi's storage format, not calling Pi. It is versioned with the package, and Pi 1.x's pi-durable will replace it wholesale. `pi/run-state.ts` (which replaced `pi/pending-operation.ts`, step 1) and `pi-session-store.ts` (`storedInput`) read it this way, both through Pi's address helpers.
- **Internal:** the meaning of `op.state` leaves, the scratch namespaces, and the requirement that a run end is one commit. That last one is observable but documented only in code. Nothing in this plan reads `op.state` or the scratch values.

## 2. The row's run copy today

Writers:

| Column | Written by |
|---|---|
| `run_id` | `runStarted` sets it (`recordRunStarted`, `session-runs.ts:229`: unless it is already that run). `runSettled` clears it (`recordRunSettled`, `:241`). |
| `run_started_at` | `runStarted`. |
| `activity_state` | `runStarted` sets `'running'`. `runSettled` sets `'finished'`, or null when a child's report reached its parent or the run started before its task closed (`:90`). `setUnread` sets `'finished'`/null (`models/sessions.ts:487`). `clearFinishedActivityForTasks` clears `'finished'` on task close (`session-store.ts:378`). |
| `settlement_count`, `settlement_json`, `settlement_next_seq` | `runSettled` (`recordRunSettled`), including `settleAsInterrupted` from recovery and `interruptRunsOn`. |
| `auto_resumes` | `takeAutoResume` (`:197`). |

The writes are driven as follows:
- `lifecycleReports` (`build.ts:89`) calls `started` for `run_start`, `run_resume` and `compaction_start`, and before the runtime drives a reopened operation (`pi-runtime.ts:339-341, 528`).
- It calls `settled` for `run_end`.
- It settles the run itself as failed when storage fails.
- It overrides the outcome to `failed`/`checkout_unavailable` for a run whose checkout could not be prepared. The runtime aborted that run, so Pi records it as `aborted` (`pi-runtime.ts:397-403`).

### What the drift looks like in practice

Read-only queries on this checkout's dev database (`.reins/reins.db`, 2,915 sessions):

- Pi's `pi.result[lastOperationId]` is `completed` while the row says `failed: "The run was interrupted: …"`, in 3 sessions. The settlement report was lost (the process exited while applying it), and recovery, finding "nothing pending", stamped the run interrupted. **A child in that state reported a false failure to its parent.**
- Pi says `aborted` and the row says `failed`/`checkout_unavailable` in 1 session. This is the override, which Pi cannot express.
- `settlement_count` equals the number of `pi.result` records in 312 sessions, is lower in 11 and higher in 3. Settlements made by Reins have no Pi result, and runs from before the settlement columns have no settlement.
- 2,351 lanes have `lastOperationId: null` and no results: sessions that never ran under AgentHarness, including legacy transcripts. 4 sessions have no lane at all. 560 sessions have results.
- The only `'running'` row is a live session, with `run_id = currentOperationId`.

## 3. Reader by reader

"Live busy" below means what `runtimeBusy` already computes (`models/session-activity.ts`): submissions in progress, or the live runtime's `isStreaming()` (an admission, a queued-steering start or a driven operation).

| Reader | Needs | From Pi / live instead? | Behaviour change and loss |
|---|---|---|---|
| `sessionActivity` (`models/session-activity.ts:21`): session views, task deletion (`models/tasks.ts:234`), moves (`session-ownership.ts:56`) | Is it busy? | **Live only.** Pi's `currentOperationId` cannot say whether the run is being driven. A run is driven only by a live runtime in this process, so busy = live busy (plus an opening started by recovery, below). | A stale `'running'` row (a lost settlement, until the next restart) no longer blocks task deletion or moves. An interrupted operation nobody drives reads as idle with `pendingOperation` (the Resume button), as it does today once it is settled. |
| `activeSessionIds` (`/api/health`) | Count of busy sessions | **Live only** (it already unions in live runtimes). | Accurate; stale rows no longer count. |
| `runInProgress` (recovery's "a new run started meanwhile" check) | The run in progress | Pi's `currentOperationId` for a session without a driver; the live runtime otherwise. | — |
| `latestSettlement` (waits, the child report's text) | Last outcome | `pi.result[lastOperationId]`, where the last operation is a run. Pi cannot express `checkout_unavailable` (it says `aborted`), a storage fault (no result) or "interrupted, given up" (still pending). **Those need Reins' record.** | A wait reads Pi's newest run result when Reins' record does not name it, so a lost settlement shows its real outcome instead of "interrupted". |
| `waitForSettlement` | At rest, and the caller's inputs consumed by a run | At rest = not live busy. An input is covered once Pi committed its entry and its operation is no longer current, which Pi commits atomically. It still awaits a run while queued (`pi.pending.entry` or inbox). | `settlement_next_seq` is not needed. The "bridging admission before the started report" case disappears: live busy has no gap from admission to the run's end (see §4). |
| `recoverInterruptedRuns` | Sessions whose run the exit cut off | Pi: lanes with `currentOperationId` set, minus those Reins already gave up on. | Finds the same runs without trusting the row. (Stranded steers on idle lanes: *Later*.) |
| Lost end effects (not handled today) | A run that ended in Pi but whose settlement never applied | Not recovered in this plan: recovery no longer stamps it "interrupted", and its effects (unread, a child's report) are lost. Catching up: *Later*. | Less wrong than today's false failure. |
| `auto_resumes` | Crash-loop budget | **Stays.** Pi knows nothing of it. | — |
| `interruptRunsOn` (node removal, `models/node.ts:178`) | Runs on the node with no live runtime | Pi pending operations on the node's sessions, minus those already given up. | Same behaviour; the source of the list changes. |
| Child reports (`child-report:<childId>:<n>`, `n = settlement_count + 1`) | A replay-stable key | **Pi's operation ID**: `child-report:<childId>:<operationId>` for Pi's end, `…:<operationId>:interrupted` for Reins' give-up. Both are deterministic from durable state, so a replay after a crash between steer and settle forms the same key. | `settlement_count` goes. The same operation can end twice, once given up and once really ended after a manual resume; the suffix keeps both reports. |
| Task-close quieting (`runStartedBeforeTaskClosed`) | When the run started | `startedAt` from `pi.result` at its end, or `op.meta` for a give-up. | A run interrupted before the close and resumed after it keeps its original start, so it stays quiet. Today the resume re-stamps `run_started_at` and it notifies. Arguably more correct. |
| Unread (`activity_state = 'finished'`, `setUnread`, `clearFinishedActivityForTasks`) | A flag the user clears | **Stays.** It records an event ("a run ended that you haven't seen") plus user actions. | — |
| Session list and detail views (`toSessionView`, `models/sessions.ts:199`), the activity snapshot (`activeSessions`, `:448`), `session_updated` broadcasts | `activityState` of `running`, `finished` or null | Derived in the session store (§4 *The session store*): `'running'` when live busy, else the row's `'finished'`/null. The snapshot is the `'finished'` rows plus the live busy sessions (excluding background ones). | Same `SessionRow` and wire shape, so **no change in the views or the frontend**. Broadcasts must follow the live state's edges (§4). |
| Scripting (`activity_state`, `unread`; `sessions.wait`) | Same | From the store, as for views. | Same schema, no change. |
| Frontend | `activityState` only (session cache, badges, polling, the Resume button via `pendingOperation`) | Unchanged. | — |

### Cross-cutting points

- **Crash consistency.** Pi commits on its own, so there is no transaction spanning Pi's end and Reins' record. The design makes that safe by direction: Pi's state is the truth, and Reins' record is a watermark of the effects it applied (child report, unread, model metadata). A crash between the two leaves Pi's end unapplied: readers that consult Pi (waits, the outcome) still see the real end, and only its effects are lost (*Later* has the catch-up; the child report's key, from Pi's operation ID, makes that replay-safe when it is built). Today the same crash yields a wrong outcome.
- **List queries over Pi JSON.** "Is it running" no longer touches the database, and no list view needs Pi JSON. Only these do:
  - recovery, once at start: a scan of every lane, about 8 ms for 2,911 lanes here, or the partial index below;
  - `interruptRunsOn`: rare;
  - the detail view's `pendingOperation`: already a point lookup.

  For a query of pending lanes, this index (checked with `EXPLAIN QUERY PLAN` on SQLite 3.53) holds only the handful of lanes with work:

  ```sql
  CREATE INDEX idx_pi_lane_pending ON pi_values(session_id)
    WHERE namespace = 'pi.lane.state' AND key = 'main'
      AND (json_extract(value_json, '$.currentOperationId') IS NOT NULL
           OR json_array_length(value_json, '$.inbox') > 0)
  ```

  A query must repeat that WHERE exactly for the planner to use the index.
- **Sessions that never ran.** No lane, or a lane with `lastOperationId: null`: no pending work, no last outcome, not busy. Waits answer `idle` from the transcript, as today with no settlement.
- **Compaction and navigation operations versus runs.** Reins starts neither in production; only tests call `lane.compact`. If it did, today's row would break: a standalone compaction reports `started` (via `compaction_start`) and never `run_end`, so the row stays `'running'`, and a navigation is not tracked at all. With live busy, any driven operation counts. Recovery resumes any kind (`resumePendingOperation` already drives whatever is current). End effects apply only to `kind: "run"` results, and "last outcome" must be the newest result of kind `run`, not blindly `lastOperationId`. Operation IDs are UUIDv7, so the newest is the greatest key.
- **In-run compaction reporting a start twice.** Gone: there is no durable start to deduplicate. The runtime only broadcasts on its own busy edges.

## 4. Target design

The rule: **running is the live state of this process. Pi's storage records unfinished work and how operations ended. The row records only what Reins decided or what the user did.**

### Columns

| Column | Fate |
|---|---|
| `activity_state` | Stays, for `'finished'` (unread) only. `'running'` is no longer written; readers ignore it except during the rollout (below). |
| `auto_resumes` | Stays. |
| `settlement_json` | Stays, as **the last run end Reins applied**: `{operationId, source: "pi" \| "reins", status, error?}`. `source: "pi"` means Pi's result, with the `checkout_unavailable` override when the runtime has one. `source: "reins"` means a Reins-made end: interrupted (budget spent, resume failed, node removed) or a storage fault. It is the outcome Pi cannot express, and marks which run end Reins applied (which a later catch-up could compare with Pi's results). |
| `run_id`, `run_started_at`, `settlement_count`, `settlement_next_seq` | Go: no reader left. Drop them in a later migration (*Rollout*). |
| model metadata (`model_provider`/`model_id`/`thinking_level`) | Unchanged; the end effects still persist the lane's model. Out of scope. |

"Given up" needs no flag of its own: Pi's `currentOperationId` equal to `settlement_json.operationId` with `source: "reins"` means Reins already ended it.

### The runtime

These are new runtime code (`pi-runtime.ts`, `build.ts`). They are optional members of `SessionRuntime`, so an app and a runtime from different reloads still work together (§ *Rollout*).

- **`isBusy()`** = `isStreaming()` or end effects still being applied (the `lifecycleReports` chain has not drained). A wait then never answers before its run's outcome is recorded, and a child stays busy until its report reached its parent, as the row ordering guarantees today.
- **Busy edges.** The runtime calls back on idle↔busy transitions. `build.ts` wires that to `session_updated` through `process.broadcast`. This replaces `runStarted`'s broadcast and makes sure the browser hears "no longer running" only once `isBusy()` is false. The browser's views now compute running from the live state, so a broadcast sent while the runtime was still streaming would leave a stale "running".
- **`whenIdle()`**: resolves on the next idle edge. It is the "idle signal" waits wanted. It comes from the runtime's own bookkeeping (admissions, queued-steering starts, driven operations, pending effects), not from Pi, so Pi's lack of an idle event no longer matters.
- **`resumePendingOperation()`** counts as an admission from its first line (`trackAdmission`), so a resume is busy before its `inspectExecution` await. When nothing is current but the inbox holds steers, it starts them (`startQueuedSteeringWhenIdle`).
- **The lifecycle sink keeps `settled`** (for Pi's `run_end`, with the operation ID, `tipId`, status, error and the override) and `storageFailed`. **`started` loses its database write**; the busy edge covers it.

### End effects (what `runSettled` becomes)

`applyRunEnd(process, sessionId, end)`, where `end` is `{operationId, source, status, error?, tipId, startedAt}`. It is the code the runtime was built with, as now. It runs these steps in order:

1. **For a child:** steer the report (`finalReply(loadBranchMessages(sessionId, tipId))`) to its parent under `child-report:<childId>:<operationId>`, or `…:<operationId>:interrupted` for a Reins-made end, through `submitToSession`, as now.
2. **One transaction:**
   - write `settlement_json`;
   - persist model metadata (from the live runtime when it has one);
   - set `'finished'` unless the child reported, or `startedAt` is at or before the task's `closed_at`. That is ms against an ISO string: convert one side.
3. Broadcast.

Its callers:
- the live runtime on `run_end` (source `pi`);
- `storageFailed` (source `reins`, `tipId` null, `startedAt` from the runtime's current run);
- recovery's give-up and `interruptRunsOn` (source `reins`; `startedAt` from `pi.op.meta`).

### Recovery at process start

`recoverInterruptedRuns`, still in the first app only, keeps today's shape. Only its source changes, because the row's `'running'` goes: it lists the sessions whose Pi lane has a current operation that `settlement_json` does not name with `source: "reins"` (pending, not given up). The query is synchronous, so the openings register before `start()` returns. For each, it spends a resume (`takeAutoResume`) and calls `Sessions.resume`, as now. When the budget is spent or the resume fails, it gives up: `applyRunEnd` with source `reins` and "The run was interrupted: the server restarted". "Nothing to resume" can no longer happen: Pi says something is pending. A session given up earlier is left alone: it shows idle with `pendingOperation`, and a prompt or `POST /resume` drives it.

A run whose end Pi committed but whose effects Reins never applied (the process exited in between) is no longer stamped "interrupted" either: its lane has no current operation, so recovery does not see it. Its effects (the unread flag, a child's report) are simply lost, which is rarer and less wrong than today's false failure. Catching them up is under *Later*.

The window between process start and the resumed runtime driving is covered:
- recovery's openings are in `OpenSessions.opening` synchronously, and `sessionActivity` counts an opening of a session with a pending operation as busy;
- the resume is tracked from its first line.

No process-owned state is added.

### Node removal

`interruptRunsOn` lists the pending, not-given-up lanes of the node's sessions without a live runtime (Pi state joined to `sources`). It gives each up with "its node was removed". Live runtimes are closed (aborted) as now, and Pi's own `aborted` end reaches the parent.

### Waits

`waitForSettlement(sessionId, timeoutMs, {signal, inputs})` loops until either the timeout or rest, defined as:
- the session is not live busy (`isBusy()` when present, else `isStreaming()`), with no submission or opening;
- **and** no named input is still queued (`storedInput` returns `queued`).

An admitted entry needs no `nextSeq`. Its operation either is current, in which case the session is busy unless it was given up (then the wait answers that), or has ended. The outcome is `settlement_json` when it names Pi's newest run result or the current operation; otherwise it is Pi's newest run result. Between checks the wait sleeps on `runtime.whenIdle?.()` raced with the deadline, the abort and a slow fallback poll (for example 250 ms, which covers old runtimes and sessions that open meanwhile). An input left queued on an idle lane after a crash is started by recovery, not waited on forever.

### The session store

The store keeps returning `activity_state` with its three values, so `SessionRow` and every reader of it (views, scripting, `sessionActivity`, `setUnread`, routes) are unchanged. It derives the value at read time: `'running'` when the session is busy, else the column's `'finished'` or null.

- **How the store knows.** The stores reach the database through module state each app sets at its start (`setDb(process.db)` in `server.ts`); they get `process.sessions` the same way, in the same call (for example `setDb` becoming `useProcess(process)`). The store reads it directly: busy is a submission in progress, an opening, or a live runtime that is `isBusy()` (or `isStreaming()` on a runtime built before `isBusy`). That rule moves from `models/session-activity.ts` (`runtimeBusy`) to beside the store, so the store does not import a model. `process.sessions` outlives the app, so the answer is right across reloads. Where nothing was set (standalone tools, tests that only set a database), nothing is live.
- **Reads.** `getSession`, `listSessions` and the other row readers apply it to each row they return.
- **Writes.** Nothing writes `'running'` any more. `updateActivityState` accepts only `'finished'`/null.
- **Queries that filter on `'running'`** cannot ask SQL any more, so they change: `listSessionsWithActivity` (the activity snapshot: the `'finished'` rows unioned with the busy sessions, excluding background ones), the running list in `models/session-activity.ts` (from the live state), recovery's query (Pi's lane state, above) and `interruptRunsOn` (the same).
- **Rollout.** A runtime built before step 3 still writes `'running'` to the column, so until the columns are dropped the store also reports a stored `'running'` as running when that session's live runtime has no `isBusy`.

`pendingOperation` stays as it is (`readPendingPiOperation` when idle).

All of Reins' reads of Pi's run state move into one module (`pi/run-state.ts`, absorbing `pending-operation.ts`). It uses Pi's exported address helpers and types, so a Pi upgrade fails typechecking there. When pi-durable arrives, it is the one place to replace.

### Rollout

- **Hot reload, runtimes on old code.** An old runtime keeps writing `run_id`/`'running'`/`settlement_count` and n-keyed child reports with its own `runSettled`. That stays harmless while the columns exist.
  - New readers duck-type: a live runtime without `isBusy` is old, and for it the row's `'running'` is honoured. Without that, the browser could miss the old runtime's last edge.
  - A `'running'` row with no live runtime is ignored; Pi's state drives recovery.
  - New app code calls only `isStreaming`/`isBusy?`/`whenIdle?` on runtimes.
  - New runtimes call nothing new on the app.
- **Child-report keys across the switch.** A crash between a child's steer and its settlement that straddles the switch from the n-key to the operation-ID key could send the parent the report twice. It is handled where the report would be sent again, a run Reins gives up on (recovery, node removal): before steering, `runSettled` checks whether the parent already holds a report of the run under the n-key (`child-report:<childId>:<settlement_count + 1>`). (In step 1 it also checked the run's Pi-end key, since recovery still gave up on runs Pi had ended; since step 2 a give-up is only of an operation Pi still has in progress, which Pi never ended.) The live path does not check: a crash there needs a window of milliseconds during one particular reload.
- **Existing rows (migration 056).** Backfill `settlement_json`'s `operationId` and `source` where it exists, and add the partial index. A plain `lastOperationId`/`source: "pi"` backfill was not enough: a run Reins gave up before the switch is still current in Pi, so recovery would resume it again (and a child report it again under the new key). So a failed record of a session not `'running'` whose lane still has a current operation gets that operation with `source: "reins"`; any other gets `lastOperationId` with `source: "pi"`. Records an old runtime writes after the migration lack both fields; readers allow it (such a record never names a give-up, so at worst a storage-faulted run is resumed at the next start). (Without a catch-up, nothing needs a record for sessions that have Pi results but no settlement.)
- **Process-owned files.** None of this touches `process-owned.json` files:
  - `process-state.ts`'s sweep keeps using `isStreaming`;
  - `OpenSessions` is unchanged (recovery's window uses `opening`, which exists);
  - `SessionRuntime` (`state.ts`, not process-owned) gains only optional members.
- **Dropping the columns** (`run_id`, `run_started_at`, `settlement_count`, `settlement_next_seq`, and NULLing leftover `'running'`) is a separate, later migration. An old runtime still live after it would fail its lifecycle writes, so apply it with a restart. The existing rule already covers this (session-runtime.md: a lifecycle-column change old code would write wrongly needs a restart).

## 5. Size, risk, recommendation

**Size:** medium, roughly 600–900 lines of source change plus test rewrites.
- `sessions/session-runs.ts`: mostly rewritten.
- `models/session-activity.ts`, `models/sessions.ts` (views, snapshot, `setUnread`) and `scripting/sessions.ts`.
- `session-runtime/pi-runtime.ts` (`isBusy`, edges, `whenIdle`, resume tracking, inbox start) and `build.ts`.
- A new `pi/run-state.ts`.
- One migration now and one later.
- Tests: `sessions/session-runs.test.ts` (most of it), `models/session-activity.test.ts`, `routes/session-activity.test.ts`, `integration/session-lifecycle.test.ts`, `integration/session-across-reload.test.ts`, `session-runtime/live.test.ts`, `scripting/sessions.test.ts`, plus the process tests for recovery.
- Docs: session-runtime.md (*Lifecycle and child reports*, *Activity and waits*, *Recovery*, *Replay idempotency*) and backend-architecture.md. An ADR (031), since it changes ADR-029's child-report key and recovery and states which store is authoritative for runs.

**Risk:** moderate.
- It touches crash paths (recovery, child reports) and the hot-reload seam.
- The new failure mode is reading Pi's storage format behind its API. That is confined to one module and typed by Pi's exports, but it is still a dependency on 0.85's format.
- Behaviour changes worth noticing: stale `'running'` rows stop blocking task deletion and moves; a resumed-after-close run stays quiet; a lost settlement is no longer reported as interrupted (its effects are lost instead, until a catch-up is built).

**Recommendation: do it, staged.** The drift is real: in this checkout's database it produced false "interrupted" reports to parents. The copy exists only because runs used to live elsewhere, and every new feature touching runs has to keep the copy and its patches in step. The parts are independent enough to stop after any step.

### Steps

1. **Record Pi's operation ID; key reports by it** (low risk, runtime and session-runs only). **Done.**
   - `runSettled` writes `operationId` (and `source`) into `settlement_json`; `SessionSettled` carries `source`.
   - Child reports use `child-report:<childId>:<operationId>` (`…:interrupted` for `source: "reins"`). A give-up does not report again when the parent already holds a report of the run, under the n-key or its Pi-end key (*Rollout*).
   - `pi/run-state.ts` replaces `pi/pending-operation.ts` (the detail view's `pendingOperation` keeps its `{kind}` shape).
   - The dead branch in `admitPrompt` (*Side findings*) is fixed.
2. **Recovery finds pending runs from Pi.** **Done.**
   - Pending lanes come from Pi (`pendingPiOperations`), not the row; give-ups are recorded as `source: "reins"`, and a run given up is left alone at later starts. A give-up is skipped when the run ended or a runtime took it up meanwhile (Pi's current operation, and the live runtime's busy state).
   - `interruptRunsOn` uses the same query.
   - Migration 056: backfill (see *Rollout*) and the partial index.
   - Until step 3, a row left `'running'` by a lost settlement stays so (recovery no longer stamps it): step 3 ignores it.
3. **Running from the live state, derived in the store.**
   - `isBusy`, busy edges and `whenIdle` on the runtime; resume tracked.
   - The store derives `activity_state` from `process.sessions` (set at app start with the database), with the fallback for old runtimes; the queries that filtered on `'running'` change.
   - `runStarted` stops writing; `run_started_at` is replaced by Pi's `startedAt`.
4. **Waits without `settlement_next_seq`.** Rest by live state plus queued inputs; outcome from §4; `whenIdle` with a slow fallback poll.
5. **Docs and ADR-031.**
6. **Later, with a restart:** drop `run_id`, `run_started_at`, `settlement_count` and `settlement_next_seq`, and NULL leftover `'running'`.

Step 3 is the one that removes the drift class.

### Later (optional)

- **Catch up lost run ends.** At process start, apply a run end Pi committed but Reins never applied (Pi's newest run result is not the one `settlement_json` names), with its real outcome. This recovers the child report and unread flag the exit lost.
- **Start stranded steers.** Recovery could also start steers left in an idle lane's inbox by a crash (see *Side findings*).

## Side findings

- **Dead branch in `admitPrompt`** (fixed in step 1). It filtered `openOperations` on `operation.kind === "prompt"`, but Pi's `OpenOperation.kind` is `"run" | "compaction" | "navigation"`. So a replayed prompt never drove its recovered operation through that branch, as session-runtime.md says it does; it only returned the existing entry. It typechecked because `openOperations` was typed with `kind: string`. Matching `"run"` alone would not have been enough: `openOperations` is what Pi reported at open, so once that run ended, a replay would have driven an ended operation and reported it started (leaving the row `'running'`). The branch now drives the reopened run only while it is still the lane's current operation and nothing drives it, and `openOperations` has Pi's `OpenOperation` type.
- **Stranded steers after a crash.** A steer committed to an idle lane, followed by a crash before `startQueuedSteeringWhenIdle` accepts it, stays in the inbox. No row says `'running'`, so recovery never looks at it. A child report steered into an idle parent is exactly this case. Left for *Later*.
- **Standalone compaction would leave the row running.** It is reported `started` through `compaction_start` but never ends with `run_end`. Latent, since Reins never starts one.

## Open questions

- Should "given up" pending operations ever be retried automatically, for example once the budget window has passed? Today they never are. The design keeps that.
- Should the unread flag become a "seen up to" marker compared with Pi's last `endedAt`? That would remove the remaining event-driven write, but `setUnread(true)` and task-close quieting make it awkward. Not proposed.
- Should `storedInput`'s transcript scan (a JSON scan of `session_messages` per wait poll) use an index on `reinsId`, now that waits rely on it alone for queued inputs? Only queued inputs need it, so the cheaper `pi.pending.entry` lookup may suffice.
