# Session runtime

Every session runs on the server ([ADR-029](../adr/029-sessions-on-the-server-nodes-host-tools.md)): AgentHarness (Pi 0.85) over the session's storage in the server's database, the server's model runtime and credentials, and Pi's tools on the node of the session's source, which only hosts them ([node-contract.md](node-contract.md) *Files*, *Shell commands*). This doc covers what the process keeps for sessions across reloads, how a runtime is opened and assembled, the environment it runs in, what it does with submitted work, the events it emits in what order, how run lifecycle and child reports are applied, and recovery.

Code: `packages/backend/src/session-runtime/` (`live.ts` opening and closing, `build.ts` assembly, `pi-runtime.ts` the runtime, `environment.ts` and `resources.ts` the environment, `tools.ts` and `reins-tools.ts` the tools, `attachments.ts`/`tool-images.ts` images, `storage.ts` storage, `events.ts` the event and message shapes, `lane.ts` the main lane), `app.ts` (what an app offers runtimes), `process-state.ts` (the process-owned state), `sessions/remote-env.ts` (`RemoteExecutionEnv`), `sessions/session-runs.ts` (run lifecycle, recovery, waits), `pi/run-state.ts` (Pi's run state read from storage) and `models/sessions.ts` (`Sessions`: submission, abort, resume, model changes, moves). The surfaces between them are typed in `state.ts`.

## What the process keeps

The app hot reloads ([hot-reload.md](hot-reload.md)); running sessions must not go with it. The server process owns them, in its `ServerProcess` (`state.ts`; created by `createServerProcess` in `process-state.ts`, from `server-process.ts`, and passed whole to every app, *Ownership* in hot-reload.md). Its `sessions` is an `OpenSessions`:

- **`live`**: the live runtimes by session ID, each an `OpenSession`: the runtime, the binding it was opened for (JSON), its last activity (`Date.now()` when it was last used, emitted an event or reported its lifecycle), `retired` (built by code of an app that is no longer current) and `faulted` (a storage call failed under it).
- **`opening`**: the openings in progress by session ID, so concurrent opens of one session share one.
- **`eventSeqs`**: the last live event seq of each session, for the life of the process, whichever runtime emits.
- **`submissions`**: the tail of each session's submission chain while it has submissions in progress (*Submission and ordering*).
- **`pauseGate`**: one `PauseGate` for the process, which every runtime shares (*Pause points*).
- **`sweep()`**: closes idle runtimes (below).

Beside it the process keeps what a runtime uses of it: `db` (the database connection its storage and attachments are on), `broadcast` (its events to the browsers), `credentialLocks` (the credential store's per-provider locks), and `app` (the current app, or none during a reload's gap; *Reaching the current app*).

An app fills `live` with runtimes built by its own code, and **a runtime keeps the code it was built with**. Runtimes leave the map four ways:

- **Idle:** the process's sweep (`sweep`, every `IDLE_SWEEP_INTERVAL_MS`, 30 s) closes a runtime idle `RUNTIME_IDLE_MS` (3 minutes), not streaming and not being opened. Closing holds nothing back: everything is in storage, and the next submission opens it again.
- **A new app:** when an app registers (`registerApp`), runtimes earlier apps built are closed at once when idle and marked `retired` otherwise; the sweep closes a retired runtime as soon as it is idle. An open meanwhile uses a retired runtime that is still streaming as it is, and reopens it on the new code once it is idle. A runtime opened by an older app's code after the new app registered (an old runtime's child report opening its parent's, *Lifecycle and child reports*) is retired from the start: each app's code has its identity (`APP_CODE` in `live.ts`, carried as `App.code`), and `openSessionRuntime` marks the runtime it opens `retired` when the current app's is another.
- **Closed by an app:** deleting a session, task or project, moving a session, removing its node and task generation's clean-up close it, aborting its run (`closeSessionRuntime(s)`, *Opening a runtime*).
- **Suspended at shutdown** (*SIGTERM*).

`process-state.ts` is process-owner code: a change to it needs a restart, and apps import only its types, through `state.ts` (hot-reload.md *What requires restart*).

## Reaching the current app

A runtime outlives the app that built it, so **it keeps the `ServerProcess`, never an `AppState` or an `App`** (`openSessionRuntime` and `buildSessionRuntime` take nothing else). What it needs of the process it uses directly:

- **Storage and attachments** on the process's database: `PiStorageAdapter` on `process.db`, and the session's attachments read and stored through the attachment store (`session-attachments-store.ts`, on `getDb()`, the stores' way to the database, which every app sets from `process.db`). No app closes it.
- **Credentials:** a `DbCredentialStore` (`pi/credential-store.ts`, the runtime's own code) under the process's per-provider locks (`process.credentialLocks`), which every store shares whichever app built it, so a runtime's OAuth refresh and an app's never race.
- **Events:** `process.broadcast` (*Events*).
- **Run lifecycle:** applied by the runtime itself (`runStarted`/`runSettled`, `sessions/session-runs.ts`, the code it was built with) on the process's database (the session row) and `process.broadcast` (`session_updated`); a child's report steers its parent through the parent's live runtime, opened if needed and in its submission chain (`submitToSession`, `models/sessions.ts`), all on the process (*Lifecycle and child reports*). No app is involved, so a reload's gap holds none of it up.

What else it needs of an app it reads from the current one at each call, `process.app`: an `App` (`state.ts`; built by `createApp(state)` in `app.ts` and registered by the app's `start`, `process.registerApp(app)`, until its `stop`):

| `App` | What a runtime uses it for |
|---|---|
| `node(nodeId)` | Its node, a `RemoteNode` of the app's hub (`sessionNode` in `build.ts`, for `RemoteExecutionEnv`, the checkout's environment and slash expansion), asked for again at each call; throws for a removed node. |
| `executeScript(sessionId, code)`, `searchScript(sessionId, query)`, `createTask(sessionId, input)` | The Reins tools' server operations for the session, scoped by its row (`serverToolCalls`, `tools/index.ts`). |

The app's handlers are product code that hot reloads: one registration (the `App`) carries them, so no runtime holds them. `process.app` is a plain property: the registered app, or undefined during a reload's gap (between the old app's `stop` and the new app's `registerApp`) and before the first app. Nothing waits for it; each kind of call handles the gap as it already handles waiting:

- **Node calls** (`sessionNode`): with no app it throws an `unavailable` failure (not sent), as for a node that is not connected, so the call waits through the gap as it waits for an offline node (`RemoteExecutionEnv`, `prepareCheckout`), and runs on the next app's link once the node redialed it. A bash call reattaching to its command (`pi.execAttach`) waits the same way, within its window.
- **Reins tools**: with no app the call fails at once, not run (`outcome: "not_run"`, "Not run: the server is reloading, try again").

An app's `stop` unregisters it and aborts the scripts it still runs for runtimes: `execute` comes back "may have run" (`outcome: "unknown"`), and one started after the stop "did not run" (`"not_run"`). Errors crossing between apps are classified by fields (`outcome`, an error's `name`), never by class: each app has its own classes.

A runtime still running old code calls the new app through `App`, and an app calls an old runtime through `SessionRuntime`: keep both small, and restart after a change that breaks either, or `ServerProcess` (with the hub's `RemoteNode`). A runtime also opens other runtimes with its own code (a child's report to its parent) and applies its lifecycle to the rows with it: a change to the session row's lifecycle columns that old code would write wrongly needs a restart too.

## Opening a runtime

`openSessionRuntime(process, sessionId, {model?})` (`session-runtime/live.ts`; an app passes its `state.process`) returns the session's live runtime, opening it from its rows when it has none:

- It reads the session row and its source (`SessionModel.source()`; none: `SessionSourceUnavailableError`), refuses a session whose node was removed (`assertRunnable`, `SessionNodeRemovedError`) and builds its **context** (`SessionModel.context`, `models/session.ts`): the `binding` (`{sourceId, cwd, createdAt, parentSessionId}`: where it runs and Pi's session identity), the `branch` its kind checks out (an `agent` task session's task branch; null otherwise), the `lane` seed (`{model, thinkingLevel}`: the row's, else the current `default_model` setting's; `off` is null) and the kind's `runtime` configuration (`{systemPrompt, tools?, environment}`, *Session kinds*). All are read from the rows at each open, so task edits and prompt changes reach a session the next time its runtime opens.
- A live runtime opened for the same binding, not retired and not faulted, is used (its last activity updated). Otherwise one opening per session at a time (`opening`, synchronous up to its registration so concurrent opens find it): a runtime streaming under another binding (the session moved) is refused, `SessionRuntimeBusyError`; a retired one still streaming is used as it is; any other is closed and a new one built (`buildSessionRuntime`, *Assembly*) and put in `live`.
- `{model}` (a model change) opens a new runtime with that model in place of the lane's, so a lane Pi has not created yet is seeded with it and one whose model is gone can be repaired; a runtime already open is used as it is.

`withSessionRuntime(host, sessionId, use, options?)` runs `use` on it, and, when a storage call failed under it (it is `faulted`), reopens it from storage and runs `use` once more: every use converges on replay (*Replay idempotency*). `liveSessionRuntime` returns the live runtime without opening one (an opening in progress is waited for). `closeSessionRuntime` closes one, aborting its run, and never rejects; `closeSessionRuntimes(ids)` closes several until none of them is open, waiting for their submissions first, since a child's run ending reports to its parent and may open the parent again (a deletion of a task or project).

## Assembly

`buildSessionRuntime` (`session-runtime/build.ts`) builds and opens one runtime:

- **Storage:** `SessionStorage` (`storage.ts`) over a `PiStorageAdapter` on the process's connection. It commits one commit at a time, rewriting each commit's writes just before (inline images become attachments the store holds, *Images*), and reports every failure before Pi sees it: Pi faults its harness on any storage error and never ends that run, so the runtime settles the run itself (failed, "Session storage failed: …") and is marked `faulted`.
- **Model:** the server's model runtime (`createPiModelRuntime`, `pi/factory.ts`: the catalog, `models.json`, the model store, offline: the server's `GET /api/models` refreshes the store) over the server's credentials (`DbCredentialStore` under `process.credentialLocks`). The model is the lane's (`storedLaneModel`, `lane.ts`), else the lane seed's, or the caller's override; one the catalog does not have throws `ModelNotFoundError` (`Model not found: <provider>/<model>`), none at all "AgentHarness Pi runtime requires an explicit model". Pi creates a missing lane (`main`, `MAIN_LANE`) from that model and thinking level when the runtime opens; once the lane exists it is the only copy of the model selection.
- **Tools** (`tools.ts`, `reins-tools.ts`): Pi's `read`, `write`, `edit` and `bash` on a `RemoteExecutionEnv` for the binding's checkout (node-contract.md *Files*, *Shell commands*), then the Reins tools `create_task`, `search` and `execute`, which call the current app (`App.executeScript`, `searchScript`, `createTask`; a failure says whether the call "may have run" or did not run, never retried). bash's environment carries `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` from the live model selection on each call. `read` of a path under the server's own `~/.agents` is served on the server (*The environment*). Every tool is registered; the lane's active tools are set to the kind's `runtime.tools` (absent: every tool) on open, so Pi offers the model only those and long-lived sessions gain new tools and drop removed ones. A name the server does not have throws `UnknownToolsError`.
- **System prompt:** the kind's `systemPrompt`, then, when the kind asks for it, the session's environment, prepared at each run's first assistant request (*The environment*). A kind without the environment and without a branch (a utility kind) gets exactly its prompt, with nothing prepared.
- **Slash expansion** of skills in submitted content (*The environment*); nothing else is expanded. Pi's own resource loading is not used: no prompt templates, extensions or context discovery.
- **Images** (*Images*): a prompt's attachment references checked against the store before admission, tool-result images stored as attachments, references hydrated to bytes for the provider.
- **Events** to the process's browser connections (*Events*); **run lifecycle** applied to the session's row by the runtime itself (*Lifecycle and child reports*).
- **Pause points** on the process's pause gate (*Pause points*).
- **Session affinity:** `x-session-affinity: <session ID>:main` at the `before_request` boundary for assistant requests to Anthropic Messages models that opt into `sendSessionAffinityHeaders` (such as Meridian). Pi's API-key path adds this header itself, but its OAuth path does not. This keeps client-owned tool rounds on one upstream session, including after a runtime reopen; compaction and other standalone requests are not joined.

A build that fails cleans up its execution environment and throws; the opening fails with it.

## The environment

A session's environment is the **server's `~/.agents` plus its checkout's**:

Both halves are discovered alike, by the server ([ADR-030](../adr/030-one-file-family-and-server-side-discovery.md)): over an `ExecutionEnv`, the context files read directly and the skills by Pi's own `loadSkills` (a directory with a `SKILL.md` is a skill and is not searched further; root `.md` files with a description count; ignore files are honoured; a skill without a description is not listed; its content is `SKILL.md` without frontmatter; what Pi warns of is logged at debug).

- **The server's** (`serverResources`, `resources.ts`): `~/.agents/AGENTS.md` and the user skills under `~/.agents/skills`, read on the server's machine over Pi's local environment (`serverAgentsDir`, resolved from `HOME` at each call).
- **The checkout's** (`checkoutResources`): the AGENTS.md files of the checkout and its ancestors (root first) and its skills (`.agents/skills`), read through its node over a **strict** `RemoteExecutionEnv` (`fs.*`, node-contract.md *Files*): a call the node did not answer fails the discovery, rather than passing for a checkout without context files or skills, and so does its signal aborting. A node's own `~/.agents` is not seen.
- **The docs** are the node's: where its REINS docs are, as its hello said (`RemoteNode.docs`); the model reads them with `read`, which runs there.
- **Merged** (`mergeResources`): the server's context file first, then the checkout's (a path already listed once); the server's skills first, a checkout skill of the same name hidden, a skill file listed once.

**Prepared at each run's first assistant request.** Pi 0.85 asks for the system prompt as an async function at each assistant request; the runtime prepares it once per run (`PrepareRun`, `resolveSystemPrompt` in `pi-runtime.ts`) with `prepareCheckout` (`environment.ts`): it waits for the session's node (however long, backing off 100 ms doubling to 2 s), checks out the task branch through the server's `Git` over `process.run` when another is checked out; then the runtime discovers the checkout's resources (`checkoutResources`, its calls waiting for the node as a tool call's do). Waiting is a pause point (the run counts as held: nothing of the request is recorded yet) and is abortable: an abort, or the runtime closing, stops it. A definitive failure (`CheckoutPreparationError`: a git failure, a missing checkout, a removed node) fails the run: the runtime aborts it and settles it failed with code `checkout_unavailable` and the reason, without asking the model. The kind's prompt is fixed when the runtime opens; the environment is read again for every run. The environment section (`environmentPrompt`) lists the active tools with their snippets, the REINS docs paths on the node (the developer docs line only when the node has `<docs>/dev`; a delivered bundle ships only `features/`; none when the node did not say), the context files and the skills (`<available_skills>`, leaving out skills with `disable-model-invocation`). Fixture tests: `__tests__/session-runtime/environment.test.ts`. `bun packages/backend/scripts/print-reins-system-prompt.ts --cwd <checkout> [--task-title … --task-description …]` prints an agent session's whole prompt as a run would get it (server resources merged with the checkout's, read locally as the local node would serve them), without creating a session.

**Slash expansion** (`expandSkills`) runs on submitted prompt and steer content before admission, for kinds with the environment: each `/name` token of a skill is expanded into a `<skill>` block (Pi's `formatSkillInvocation`: its `SKILL.md` without frontmatter) at the start of the first text block. The server's skills are tried first; only a name the server has no skill of discovers the checkout's (through its node, within 10 s, not waiting for a node that is not connected), and that failing fails the submission ("The checkout's skills are unavailable (…)"). Names no skill has are left as they are. A utility kind's content is admitted as submitted.

**Reading the server's skills: a stopgap** (to revisit, ADR-029 *Later*). The server's skills are listed with their paths on the server's machine, but the model reads a skill with `read`, which runs on the node. So `read` serves paths under the server's `~/.agents` on the server (`readingServerDir` in `tools.ts`: those file operations go to a local `NodeExecutionEnv`); every other operation and path goes to the node.

**Skill suggestions.** `GET /api/projects/:id/skills` (`routes/skills.ts`, `SourceModel.listSkills`; the composer's `/name` suggestions) lists the skills a session in the request's source can invoke, merged the same way (the checkout's discovered through its node within 5 s): `{skills, available: true}`. When the node is not connected, does not answer in time or fails, it answers the server's skills with `available: false` (200, logged at debug). The frontend keeps its last known suggestions when `available` is false and takes the partial list only while it knows none (`ProjectStore.fetchSkills`/`fetchLists`).

## Session configuration and kinds

The server resolves a session's model and thinking level once, at creation (`createSession` in `sessions/create-session.ts`): the creation override, else the `default_model` setting (thinking: the override's level, else the default's). A `default_model` of another runtime is rejected there and when seeding a lane (`piModelSetting` in `models/model-settings.ts`). They are stored on the session row; a later `default_model` change never reaches an existing session. Session creation writes nothing else: Pi's main lane is created the first time the session's runtime opens, seeded from the row (*Assembly*), and from then on the lane is the only copy of the model selection.

### Session kinds

A session's **kind** (`sessions.kind`, migration 046; `"agent"` unless created as another) defines how it runs: its system prompt, its tools, whether its environment is appended and which branch is checked out first. There is no per-session prompt: it comes from the kind. Kinds live in a registry on the server (`sessions/session-kinds.ts`): a name → a resolver that, given the session's row and its task's, returns `{systemPrompt, tools?, environment, branch?}`, read at every runtime open (`SessionModel.context`). Defining a kind is one entry (`registerSessionKind(name, kind)`, which returns its removal). Kinds are validated in code, not by the database, so a new kind needs no migration; `createSession(state, projectId, {kind})` rejects an unknown one, as does opening a runtime for a row whose kind is no longer registered. Only server code creates sessions of a kind; scripts can neither create nor see them ([ADR-019](../adr/019-server-generated-system-prompt-and-session-kinds.md)).

- **`agent`** (every existing session): the Reins prompt (`reinsSystemPrompt` in `sessions/system-prompt.ts`: the persona and editing guidelines, session orchestration when the session is offered `execute`, and the task section for a task session or the project-assistant section for a scratch session), every tool (`tools` absent), the environment appended, and its task's branch checked out (a task session).
- **Utility kinds**: a fixed system prompt, a chosen tool list (typically `[]`) and `environment: false`, so the model sees exactly the kind's prompt. **A utility kind has no side effects:** no tools, no environment, no checkout (no branch, even on a task session) and no slash expansion, so it needs no node. Background sessions (`background: true`) are the usual home for them.
  - **`task-generator`** (built in): parses freeform intent into a task's `{title, description, branch_name}` JSON, with `tools: []`. `generateTask` (`sessions/task-generator.ts`, for `POST /api/projects/:id/tasks/generate`) creates a background session of it on the request's source with the utility model (the `utility_model` setting, else `default_model`'s; neither: no session, the deterministic task), submits the user's text and waits for its settlement (`waitForSettlement` with the submitted `clientId`, 30 s in all). The session exists only for the request: whatever the outcome its runtime is closed (aborting a run) and it is deleted (its row, cascading to its transcript and attachments). A timeout, a failed submission or run, or a reply that is not the expected JSON gives the deterministic task (the prompt as title and description, a slugged branch).

## Runtime operations

`AgentHarnessPiRuntime` (`pi-runtime.ts`, a `SessionRuntime`) wraps one AgentHarness lane (`main`):

- **`prompt(content, {reinsId, metadata})`** expands slash skills, then durably admits a `reinsInput` message keyed by `reinsId` (the submission's `clientId`) and drives the run in the background; it resolves with the entry ID once Pi committed it, without waiting for the response. A replay of an admitted `reinsId` returns the existing entry (and drives the run an interruption left pending, while it is still the lane's current operation and nothing drives it); a concurrent admission of the same input is joined. If a passively reopened operation is pending, the prompt is queued as steering and resumes it instead of failing with `LaneBusy`. A prompt to a lane already running fails ("Lane "main" already has an active operation"): running sessions take steers.
- **`steer(content, …)`** durably queues the input through Pi's native steering: active work consumes it, an idle lane starts a run from it, a passively reopened operation is resumed. Replays of a queued or admitted `reinsId` do nothing. There is no Reins follow-up queue or abort/restart fallback.
- **`resumePendingOperation()`** drives an operation reopened passively after an interruption, without adding input, and returns true. Replay-safe: true as well when the operation is already being driven (an input joined it first), false when there is nothing to resume. Reopened operations stay passive until resumed, steered or joined by the next prompt. Driving one reports its run started again (Pi emits no `run_start` for it, and the server may have settled it as interrupted).
- **`abort()`** requests abort of the active operation (stopping a system prompt still being prepared) and waits for the lane to go idle; queued steers are discarded. With nothing active it does nothing.
- **`setModel({provider, modelId, thinkingLevel?})`** validates the model against the server's catalog and writes it (and the thinking level, if given) to Pi's lane, effective from the next LLM turn; bash's environment follows it.
- **`isStreaming()`** is true while an admission, a queued-steering start or an operation is in flight: activity (*Activity and waits*), idle eviction and retiring use it.
- **`isPaused()`** is true when cutting the runtime off would lose nothing: no admission or tool call in flight, and every run it drives held at a pause point. An idle runtime is paused.
- **`close()`** waits for admissions, aborts, closes the harness and cleans up its execution environment (killing commands it still runs on the node).
- **`suspend()`** closes the harness without aborting: the run stays pending in the session's storage, where the next runtime to open the session resumes it. A run held at a pause point loses nothing; a request or tool call still in flight is cut off (its abort signal fires) and recovered by Pi on resume. It first detaches its execution environment (`RemoteExecutionEnv.detach`), so the cut-off call's abort only stops reading its command and cleaning up kills nothing: a command bash runs goes on on the node, for the resumed call to pick up (*Recovery*).
- `getMessages()` and `waitForIdle()` are test support.

Durability: AgentHarness is the only transcript writer. Entries, lane values, lists and usage commit through `PiStorageAdapter` into the server's database (see [session-message-persistence.md](session-message-persistence.md)). Runtime events never trigger transcript writes.

### Pause points

A **pause point** is where nothing has started that cutting the run off would lose: the assistant step's `before_request` (the run is `assistant.ready` or `assistant.retry_wait`: its request is not recorded yet), `before_tool` (the call is still `planned`) and waiting for the node while the run's system prompt is prepared. While the process's `PauseGate` is closed (only at shutdown, *SIGTERM*), the two hooks wait for it to open or for the run's abort signal. Both are clean: Pi resumes a run cut off there into a fresh request, without an interrupted message or a retry attempt, or runs its tool normally. A compaction summary's `before_request` is not one: Pi records that effect before asking. The hooks return when released, never throw: Pi catches a hook's error, and a throwing `before_tool` blocks its tool. An abort releases a held run, which then ends aborted as usual.

For `isPaused`, the runtime tracks its held runs and, by run, the tool calls in flight between `tool_start` and `tool_end`, the events Pi emits when it commits a call's intent and its outcome. Pi 0.85 exposes no inspection of in-flight effects, and its tool calls run in parallel by default, so a run can be held before one call while another runs. A run's tracked calls go when its drive ends, so a call whose end never came (its harness faulted) cannot keep the runtime from pausing. Where a run is cut off elsewhere decides what resuming costs: mid-request, Pi records the saved partial output as interrupted and asks again (one retry attempt); mid-tool, it reruns the tools marked `replay: "safe"` and gives the model the last saved output with "outcome unknown" for the others (`write`, `edit`, `execute`, `create_task`). The safe ones are `read` and the Reins `search`, both read-only, and `bash`, whose rerun never runs its command again but picks it up on the node (*Recovery*, Bash across a restart).

A node reload or shutdown pauses no run: it drains its own commands (node-contract.md *Pausing a node*), and a run's tool calls wait for the node.

## Submission and ordering

Submitted session work goes straight to the session's runtime; Pi's durable admission is its record (there is no outbox). `Sessions.submit(sessionId, {op, content, clientId, sourceSessionId?})` (`models/sessions.ts`; the browser socket's prompt and steer, scripting sends, code-review prompts, task generation; over `submitToSession(process, …)`, which needs only the process, so a runtime's child report submits through it too) opens the session's live runtime (`withSessionRuntime`) and admits the input with `prompt` or `steer` under `reinsId` = `clientId` (with `metadata.sourceSessionId` for an addressed steer), resolving once Pi committed it.

- **Order:** a session's submissions and model changes apply one at a time in arrival order: each enters the session's chain (`OpenSessions.submissions`, process-owned, so across apps) synchronously when called.
- **Replay:** a repeat under the same `clientId` converges on the admitted input and resolves again.
- **Failure** is the submission's own answer: the HTTP error, the browser socket's `{type: "error", sessionId, clientId, error: "prompt failed: …"}`, a script's thrown error.
- **Refused before anything is submitted:** an unknown session, content over `MAX_PROMPT_CONTENT_BYTES` (8 MiB as JSON; `PromptTooLargeError`, "Prompt too large: …") and a session whose node was removed (`SessionNodeRemovedError`, HTTP 409).
- **A node that is offline** does not hold admission up: the run waits for it at its first assistant request and its tool calls wait for it, however long (until the run is aborted or the node removed; node-contract.md *Files*), except that expanding a skill only the checkout has fails the submission. Acknowledging may first open the session's runtime.

### Abort and resume

`Sessions.abort(sessionId)` (the WS `abort` message) acts on the session's live runtime at once, not ordered behind submissions: `{aborted}` says whether it was busy; with no live runtime it answers `{aborted: false}` and opens nothing. `Sessions.resume(sessionId)` (`POST /api/sessions/:id/resume`) drives the operation an interruption left pending in its live runtime (opened if needed): `{started: true}` while it is being driven (also when an input joined it first), `{started: false}` with nothing to resume (409 from the route). Neither needs the node.

### Model changes

`Sessions.setModel` (HTTP `PUT /api/sessions/:id/model` and scripting `sessions.setModel`) enters the session's chain when called, validates the provider/model against the server catalog (`findPiModel`), applies it through the live runtime's `setModel` (opening the runtime with the requested model if needed, which seeds a lane Pi has not created yet or repairs one whose model is gone), then updates the row and broadcasts `session_updated`. A running prompt picks it up from Pi's next request. Omitting `thinkingLevel` keeps Pi's current level. A failure is the request's error (400 over HTTP; a removed node 409) and leaves the row as it was.

### Replay idempotency

There are no receipt tables ([ADR-010](../adr/010-state-derived-idempotency.md)): "already applied" is derived from state, so a replay is acknowledged as success and applies nothing twice.

- **prompt:** Pi admission is durable (`lane.accept` commits the `reinsInput` keyed by `reinsId`). A replay finds that input and answers it; an in-flight admission of the same input is joined. A recovered operation is driven again only if not already active.
- **steer:** `lane.steer` commits the queued input and Pi moves it from queue to transcript in one commit, so checking the queue first, then entries, cannot miss it. Residual: an abort discards queued steers, so a steer replayed after an abort discarded it is queued again.
- **model changes:** an absolute selection, re-applied.
- **lifecycle reports:** a `started` for the run already in progress applies nothing (Pi reports it again on in-run compaction). A settlement is created in-process and applied once, never resent (*Lifecycle and child reports*).
- **child reports:** steered under a key derived from the child and Pi's operation ID (`child-report:<childId>:<operationId>`, with `:interrupted` for an end Reins made), which Pi recognises when repeated.

## Images

**Images never reach storage or events as bytes.** User prompt images are attachment references from the start (uploaded to the session's attachments first); before admission the runtime checks each against the store and caches its bytes (`materializePromptAttachments`, `attachments.ts`; one the session does not hold, one whose stored MIME type, size or sha256 differs from what the reference declares, or two references to one ID that disagree, throw `InvalidAttachmentError`). The store is the process's database, read and written synchronously (`getSessionAttachment`/`storeSessionAttachment`); its bytes are not re-hashed on read. Tool-result images are converted where Pi produces them: the `after_tool` hook (`toolImageReferences`, `tool-images.ts`) replaces each inline image with a reference before Pi stages the result, reusing a cached attachment of the session with the same sha256 and MIME type, else **storing the bytes now** under a new ID (`att_<uuid>`, `storeSessionAttachment` on the process's database), so the store holds them before any commit references them. Images outside the upload allowlist, empty or over 10 MiB, and images whose storing fails, become a text note (`[Image omitted: …]`). `SessionStorage` applies the same conversion to any inline image Pi commits without the hook (recovered checkpoints, hooks cut short by abort). Provider input is hydrated from the runtime's cache (`AttachmentCache`, which saves reading each image's blob for every provider request), reading a miss from the store, with each reference checked against it as at admission; one the store no longer holds becomes `[Image attachment missing]`. Stray inline images in live events (partial tool results) are replaced by `[Image attachment unavailable]` (`sendableEvent` in `events.ts`), which scans only events that can carry images (message snapshots on `message_start`/`message_end`, `turn_end`, `agent_end`, `entry_added`, and tool results in `tool_execution_update`/`tool_execution_end`); streaming assistant updates hold only text, thinking and tool calls and skip it. **This check is the only guarantee that events carry no image bytes.** `read` of an image on the node returns its bytes over `fs.read`; they become an attachment on the server like any tool-result image.

## Events

Each runtime emits normalized `AgentRuntimeEvent`s (`events.ts`) to its `emit` sink, which serializes each once (`sendableEvent`), gives it the session's next seq (`OpenSessions.eventSeqs`: per session for the life of the process, starting at 1) and broadcasts it to every connected browser as `{"event":<event>,"type":"event","sessionId":…,"projectId":…,"seq":…,"emittedAt":…}` (`sessionEventFrame` in `models/broadcast.ts`, sent through `ServerProcess.broadcast`; the envelope fields come after the payload, so duplicate keys inside it cannot override them; `emittedAt` is the server's wall clock at emission, for latency diagnostics only). Events are best effort and live only: there is no replay or resync, a lost event only affects live rendering (the transcript comes from storage), and browsers detect gaps by `seq`. Run lifecycle is not an event. Native Pi events are mapped explicitly; nothing is passed through unchecked.

| Pi harness event | Runtime event | Notes |
|---|---|---|
| `run_start` | `agent_start` | |
| `turn_start`, `turn_end` | `turn_start`, `turn_end` | `turn_end` carries the message and tool results |
| `message_start/end` | `message_start/end` | The complete message snapshot and a `streamId` stable for that message's lifecycle; `message_end` carries `entryId` when Pi exposes the durable entry. Includes user and tool-result lifecycles: consumers check `message.role` |
| `message_update` | `message_update` | Assistant streaming only: `{streamId, assistantMessageEvent, message?}`. See *Streaming message updates* |
| `entry_added` | `entry_added` | The canonical `ConversationEntry` envelope: `id` (harness entry ID), `parentId`, `seq`, `clientId` (the `reinsId` of a `reinsInput`) and the content-only message. Message and compaction entries only |
| `tool_start/update/end` | `tool_execution_start/update/end` | Stable `toolCallId` and canonical tool name; `tool_execution_end.result` is `{content, details?}` |
| `retry_scheduled`, `retry_end` | `auto_retry_start`, `auto_retry_end` | UI diagnostics |
| `compaction_start/end` | `compaction_start/end` | Not a terminal boundary |
| `run_end` | `agent_end` | `runId`, `status` (`completed`/`failed`/`aborted`), structured `error` when failed (a run whose checkout could not be prepared: `checkout_unavailable`), and the run's non-input messages (diagnostics only) |

### Streaming message updates

A `message_update` carries Pi's own step as `assistantMessageEvent`, without Pi's `partial` snapshot (`AssistantStreamEvent`): `text_start`/`thinking_start`/`toolcall_start` `{contentIndex}`, `text_delta`/`thinking_delta`/`toolcall_delta` `{contentIndex, delta}`, `text_end`/`thinking_end` `{contentIndex, content}` and `toolcall_end` `{contentIndex, toolCall}`. Every delta is sent: there is no time-window coalescing, so text streams token by token.

The full message is included as `message` only as a **keyframe**: on the stream's first update, on every block start (a new block's identity, such as a tool call's ID and name or redacted thinking, is only in Pi's snapshot), and otherwise when `MESSAGE_KEYFRAME_INTERVAL_MS` (1 s; injectable with the clock as `messageKeyframes`) has passed since the stream's last keyframe. A keyframe is the message after its step. Its content is built from the steps sent so far (`applyStreamStep` in `pi-runtime.ts`), not copied from Pi's `partial`: that is the provider's live message and can already hold steps the harness has not delivered, which a client applying later deltas would double. A tool call still streaming carries its raw argument JSON so far as `partialJson` (providers name or omit that field differently); its parsed `arguments` stay as they were at the block start until `toolcall_end` carries the complete call.

Applying a step (Pi's semantics, the same on server and browser): a block is as its start keyframe shows it, `text_delta`/`thinking_delta` append to `text`/`thinking`, `toolcall_delta` appends to `partialJson`, and `*_end` is authoritative (`text_end`/`thinking_end` replace the text; `toolcall_end` replaces the block). Signatures reach the browser with the next keyframe or `message_end`.

### Ordering

A simple completed run (each committed message is also announced by an `entry_added`):

```text
agent_start
→ turn_start
→ message_start/update…/end
→ tool_execution_start/update…/end   (per tool call)
→ turn_end
→ … further turns …
→ agent_end(status=completed)
```

With automatic compaction:

```text
agent_start → … turns … → compaction_start → compaction_end → agent_end(status=completed)
```

AgentHarness emits `run_end` from the durable terminal commit, after everything the operation owns: provider retries, deferred polling, accepted steering and automatic compaction. So compaction, retries and steering appear **inside** the run, before the single `agent_end`; `compaction_start` may precede the first turn. Failed and aborted runs end with `status=failed`/`aborted` and preserve the native error. There is no later synthetic settlement. During the `run_end` callback `isStreaming()` may still be true (local cleanup follows event delivery); nothing derives the lifecycle boundary from it. Events and lifecycle travel separately: a browser can see `agent_end` before or after the settled session update.

### How the frontend consumes events

- `entry_added` is the only way a durable chat entry appears live; message pages return the same envelope. The frontend upserts by `id` and resolves an optimistic input only when an entry carries its `clientId`: no FIFO, content or timestamp matching.
- Streaming messages (`message_*` by `streamId`) are presentation overlays built from snapshots and deltas (*Streaming message updates*); a sequence gap makes an overlay wait for the next keyframe (frontend-architecture.md, `ConversationsStore`). `message_end.entryId` lets the overlay be removed when its entry arrives. `agent_end` clears remaining overlays and surfaces the terminal error; it never inserts transcript entries.
- `compaction_start`/`compaction_end` drive the compacting indicator; `auto_retry_*` show retry status.

**Context occupancy** is not an event: the session context REST resource reads the active `main` branch and uses the usage in the latest valid assistant message with AgentHarness's `estimateContextTokens` semantics (so standalone structural calls such as compaction summaries never count). `entry_added` and `compaction_end` schedule a refresh; `compaction_start` marks the previous measurement unknown; after compaction the replacement context is estimated until the next assistant response.

## Lifecycle and child reports

The runtime calls its `RuntimeLifecycleSink` `started(runId)` for Pi's `run_start`, `run_resume` and `compaction_start` (and before driving a reopened operation), and `settled(runtime, outcome)` for `run_end`. `lifecycleReports` (`build.ts`) applies them itself (`runStarted(process, sessionId, runId)`, `runSettled(process, settled)`, `sessions/session-runs.ts`, on the process's database and broadcast; no app is involved, so a reload's gap changes nothing), one at a time in occurrence order, with the lane's model and thinking level and Pi's committed `run_end.tipId`. Pi emits each after the commits it follows, so a settlement is applied after them. One that fails is logged and lost, as is one still being applied when the process exits (*Recovery*). Closing or suspending a runtime waits for its reports being applied. Opening a runtime emits no settlement.

- **`started`** sets `run_id` (the run in progress) and the session's activity `running`; a `started` for the run already in progress (Pi re-reports it on in-run compaction) applies nothing; one for a run that already settled applies (Pi resumed it).
- **`settled`** (`SessionSettled`: `runId`, Pi's operation ID; `source`, `pi` for Pi's `run_end` or `reins` for an end Pi cannot express: a give-up, a storage fault; `status`, `error?`, `metadata`, `tipId`) is applied in **two ordered steps**. For a child, its final reply (`finalReply` of `loadBranchMessages(sessionId, tipId)`: the branch Pi captured in `run_end`, never a newer main tip; clean result or error text) is first steered to its parent (`submitToSession`, `models/sessions.ts`: the parent's live runtime, opened if needed, in the parent's submission chain, `runtime.steer` under `reinsId` `child-report:<childId>:<operationId>`, or `child-report:<childId>:<operationId>:interrupted` for an end Reins made (the same operation may still end in Pi after a manual resume: another report), with `metadata.sourceSessionId`), which Pi commits on the parent's lane (`lane.steer`). Then one transaction records the settlement on the session row (`sessions/session-runs.ts`): clears `run_id`, increments `settlement_count`, records the last run end Reins applied (`settlement_json`: `{operationId, source, status, error?}`), the storage's `harness_next_seq` at that moment (`settlement_next_seq`, for waits), persists the model metadata, and sets the activity: a child whose report reached its parent clears to idle, a top-level session becomes `finished` (unread), unless its run started before its task closed. Broadcasts happen after commit. **A crash between the two steps** after Pi's end leaves the settlement unapplied: Pi has nothing pending, so recovery does not see it, and the parent heard of it once. A run Reins gives up is not reported again when the parent already holds a report of it under `child-report:<childId>:<n>` (`n` the settlement's count), the key code before the operation-ID key steered it under. A reply that cannot be read, or a parent that cannot receive it (outside the child's project or task, its node removed, admission failed), is logged and leaves the child `finished` with no report.
- **A storage failure** settles the run in progress failed ("Session storage failed: …", `tipId` null) and the runtime reports nothing more (*Assembly*).

### Activity and waits

Server code reads a session's state from its rows and the process's runtimes:

- **Activity** (`models/session-activity.ts`): `sessionActivity(row, sessions)` is `running` when `activity_state` is `running` (set and cleared by lifecycle reports), or when the session has submissions in progress or its live runtime is streaming (`isStreaming`), so an admitted prompt is busy from its admission; else `idle`. `activeSessionIds(sessions)` applies the same rule across sessions. Reading writes nothing. Used by session views (`pendingOperation` only when idle), task deletion (any non-idle session blocks it), moves and `/api/health` (`activeSessions`, `streaming`). Browsers see the row's `activityState` (`running` from the run's `started`, then `finished` or null).
- **Wait** (`waitForSettlement` in `sessions/session-runs.ts`, behind `SessionInstance.wait` and `api.sessions.wait`): polls every 10 ms and resolves once the session is idle and every input the caller names (`inputs`: clientIds it submitted, as task generation does) that Pi admitted is covered by a settlement: an input still queued as steering awaits a run; a transcript entry is covered once the latest settlement was applied after it (`settlement_next_seq` above its seq). An input Pi never admitted expects no run. The result is the transcript's final reply with the latest settlement's status/error (`completed`/`failed`/`cancelled`, or `idle` with no reply), `timeout` at the deadline; an `AbortSignal` rejects with `AbortError`.

## Recovery

**A reload recovers nothing**: runtimes never leave memory; during the gap their node calls wait, their Reins tool calls are not run and their run lifecycle is applied as at any other time (*Reaching the current app*).

**At process start** the first app (`start(process, {recoverRuns: true})`, `server.ts`) resumes every run Pi has in progress (`recoverInterruptedRuns` in `sessions/session-runs.ts`): the previous process suspended it at SIGTERM or a crash cut it off, and Pi left its operation pending in storage. Pi's storage says which: the sessions whose main lane has a current operation (`pendingPiOperations` in `pi/run-state.ts`, over the partial index `idx_pi_lane_pending`, migration 056), except those whose last recorded run end (`settlement_json`) names that operation with `source: "reins"`: Reins gave it up already. Nothing reads the row's `'running'`. Each is opened and resumed (`Sessions.resume`). It is **given up** instead (settled as interrupted: failed, "The run was interrupted: the server restarted", through `runSettled` under its operation ID with `source: "reins"`) when the resume fails, or when the session has used up its automatic resumes: `AUTO_RESUME_LIMIT` (3) within `AUTO_RESUME_WINDOW_MS` (10 min), counted on the session row (`sessions.auto_resumes`, migration 052, `takeAutoResume`), so a run that crashes the server does not crash it at every start and a restart does not reset the budget. A run that ended, or that a submission took up, while its resume was in flight is left alone. A run given up stays pending in Pi: later starts leave it alone, and a prompt or `POST /api/sessions/:id/resume` drives it. A run whose end Pi committed but whose settlement the exit cut off is not seen (nothing is pending): its effects (the unread flag, a child's report) are lost.

**Removing a node** (node-contract.md *Pairing and authentication*, Removal) closes the live runtimes of its sessions, aborting their runs (a tool call waiting for the node fails), and gives up as interrupted any run Pi has in progress there without a live runtime, as recovery finds them ("The run was interrupted: its node was removed"; `SessionRuns.interruptRunsOn`).

**A node restart** interrupts only the tool calls in flight on it: a command it lost comes back "outcome unknown"; everything else waits for it (node-contract.md *Shell commands*).

**Bash across a restart.** A bash call survives the server process going away mid-command (SIGTERM, a crash, a restart of the server alone under the supervisor, hot-reload.md *Restarting the server*): bash is `replay: "safe"` (`reattachingBash` in `tools.ts`), and its command runs under an ID recorded with the call before it is sent. Pi reruns a safe call an interruption cut off with the same invocation (`recoverToolInvocation` in Pi's `runtime/drive/tools.js`; it has already deleted the call's checkpoint), and keeps the call's memos (`invocation.getMemo`/`setMemo`) until its outcome is committed. So:

- **First run** (no `exec` memo): it chooses an `execId`, commits it (`setMemo("exec", {execId})`) and only then runs the command under it (`RemoteExecutionEnv.execCommand`). It also keeps each output it checkpoints as the memo `output` (best effort), since Pi deletes its own checkpoint before a rerun.
- **Rerun** (the memo is there): it never sends the command; it attaches to it on the node by that ID from the start of its output (`execCommand` with `attach`, `pi.execAttach` from offset 0), which replays the output the node kept (or its current view) and the exit, if the command finished within the node's grace period (60 s from when the server's link dropped). The model sees the real result, as if nothing happened.
- **A command the node does not have** (the node restarted, the server was away past the grace period, or the server stopped between committing the ID and sending the command) gives what Pi gives a call it cannot rerun: the saved output (the memo, or what the rerun got before losing it) and Pi's interruption text ("…the external outcome is unknown"), as an error.

Nothing sends a command twice: the only path that sends it is a first run, after its ID is committed, and `RemoteExecutionEnv` resends `pi.exec` only while it was certainly not run. A bash call recorded before this (Pi records `replay: "never"` with the call's intent) keeps "outcome unknown". The other tools that change things (`write`, `edit`, `execute`, `create_task`) still come back "outcome unknown".

### SIGTERM

On SIGTERM or SIGINT, and before exiting to be restarted alone (`exitProcess`), the server process (`server-process.ts`) runs `suspendSessions` (`process-state.ts`): it closes the process's pause gate, waits up to `SHUTDOWN_PAUSE_MS` (3 s) for every live runtime to be paused (`isPaused`) and no opening to be in progress, logs how many were not, then suspends every runtime (`suspend`: not aborted, and its commands left running on the node; bounded by 5 s) and exits through `exit` (removing the node socket file). A run held at a pause point loses nothing; one cut off mid-request or mid-tool is recovered by Pi when the next process resumes it, a bash call by picking its command up again (*Recovery*, Bash across a restart). A run in a bash call is not paused, so a SIGTERM during a command waits the 3 s and logs it. Tested with real processes in `__tests__/server-process.process-test.ts` (`bun run test:process`): SIGTERM pausing and the next process resuming, a bash command running through a SIGTERM (picked up again; finished while the server was down; lost with its node: "outcome unknown"), a server killed mid-request, a node killed mid-run, a dev reload mid-run; and in `supervisor.process-test.ts`, a bash command running through a restart of the server alone, its node never restarted.

## Messages

`RuntimeMessage` (`events.ts`) is Reins-normalized:

- `reinsInput` (canonical storage only) carries block content, a stable `reinsId` and application `metadata`. Projections show it as `role: "user"` (with `metadata` when present). Provider projection strips both fields and, when `metadata.sourceSessionId` is set, frames the content as a Reins session update that is not new user authorization.
- User content is blocks: `{type: "text"}` and image attachment references; bytes are hydrated only at the provider boundary.
- Assistant content: `text`, `thinking` (with optional `thinkingSignature`) and `toolCall` blocks; `stopReason`; a `timestamp` stable across the message's lifecycle.
- Tool results: `toolCallId`, `toolName`, `content`, `isError`, `timestamp`.
- Compaction: `role: "compactionSummary"` with `summary` (no `content`).

Metadata is supplied at admission and never reconstructed from timestamps, IDs, content or position.

## Session orchestration

Scripts reach sessions through `api.sessions` (see [scripting](../features/scripting.md)); `sessions/session-instance.ts` implements it over `Sessions.submit` and projections (`sessions/session-runs.ts` for waits):

- `start(prompt, options)` creates a session (child or independent, depth limit three) on the caller's source and submits its prompt; it returns `{sessionId}` once the prompt was admitted, without waiting for the run.
- `send(sessionId, message)` submits a steer with `metadata.sourceSessionId` for any session in the caller's project, resolving once admitted; Pi's native steering decides how it joins or starts work.
- `wait(sessionId, timeoutMs?)` observes settlement through server projections (*Activity and waits*), bounded to 0–30 000 ms; cancelling it never aborts the target.

Sessions share their source checkout; no lock is held across execution, and parent links do not propagate cancellation.

## Tests

`__tests__/session-runtime/live.test.ts` (a run to settlement on a server-only model with a tool call on the node, an unknown model, the environment merge with the task branch checked out, tool-result images, a checkout that cannot be prepared, a node offline at the first request: held, abortable, a bash command running through a suspension and picked up by the resumed run), `pi-runtime.test.ts` (`AgentHarnessPiRuntime` over the server's storage: admission and replay, steering, retries, deferred and compacted runs, recovery of reopened operations, streaming keyframes, session affinity, abort and close, pause points and suspend/resume), `environment.test.ts` (the environment prompt's fixtures, slash expansion), `resources.test.ts` (the server's `~/.agents` and the merge), `tools.test.ts` (the host tools, the `read` stopgap, bash's command ID memo and its rerun: attach only, or "outcome unknown"), `reins-tools.test.ts` (the Reins tools' model-visible surface and failures), `attachments.test.ts`, `tool-images.test.ts`, `events.test.ts` (no image bytes in events), `lane.test.ts` and `storage.test.ts`; `__tests__/process-state.test.ts` (idle eviction, retiring on a new app, the current app property, suspending at shutdown); `__tests__/integration/session-across-reload.test.ts` (an app replaced under a running session mid-tool-call; a reload's gap held open: a bash call waits and runs on the next app's link, a Reins tool call is not run, a run's lifecycle is applied at once; a runtime opened by another app's code is retired); `__tests__/pi/credential-store.test.ts` (stores over the process's lock serialize a provider's modifications); `__tests__/models/sessions.test.ts` (order, replay, failures, model changes, abort and resume); `__tests__/sessions/session-runs.test.ts` (child reports and the crash between their steps, lifecycle and a child's report with no app, recovery at process start and its budget); `__tests__/sessions/remote-env.test.ts` (the remote environment against Pi's local one, waiting for an offline node, reattaching commands, picking a command up by its ID alone, detaching). Tests drive a scripted model (`__tests__/helpers/fake-model.ts`; process tests set the **test-only** `REINS_TEST_FAUX_PROVIDER`, `pi/test-faux-provider.ts`, never in production).

## Adding or replacing a runtime

A future runtime (pi-durable once stable, the Claude rebuild, an ACP adapter; see [ADR-006](../adr/006-acpx-as-runtime-replacement.md)) plugs in on the server behind `SessionRuntime` and must keep the contracts above: durable admission keyed by `reinsId` (replays must converge, *Replay idempotency*), native steering, the normalized event table with stable `streamId`/`toolCallId`, `entry_added` envelopes, one terminal `agent_end` and one settlement per run, lifecycle reports ordered after the commits they summarize, attachment references instead of image bytes, pause points, tools on the session's node through an `ExecutionEnv`, and the Reins tool set. For conversation trees it must also continue from an arbitrary persisted prefix (native fork or exact prefix hydration); pasting a transcript into a new prompt is not equivalent. AgentHarness already stores tree-shaped ancestry and selects context through a lane branch tip.
