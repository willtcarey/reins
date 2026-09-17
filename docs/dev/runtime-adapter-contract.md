# Runtime Adapter Contract

This document describes the minimum contract a Reins runtime adapter must satisfy.
It is based on the current `packages/backend/src/runtimes/` code and the frontend event consumers.

## Where runtimes plug in

Runtime adapters are registered with `registerRuntimeAdapter()` and selected by the session row's `agent_runtime_type`.

The orchestration path is:

1. `runtimes/sessions-manager.ts` creates or reopens a Reins session.
2. `createAgentRuntime(runtimeType, ...)` finds the adapter.
3. The adapter builds an `AgentRuntime` for the project/session/task.
4. Runtime events are broadcast to the frontend and observed for lifecycle state.
5. AgentHarness commits transcript entries directly through `PiStorageAdapter`; the observer never writes message snapshots.

Only the AgentHarness Pi adapter is currently registered. The Claude SDK implementation remains in-tree but unregistered.

## Minimum viable `AgentRuntimeAdapter`

A runtime adapter must implement `AgentRuntimeAdapter` from `runtimes/registry.ts`:

- `runtimeType`
  - Stable string stored in `sessions.agent_runtime_type` and settings.
  - Treat as persisted API; do not rename casually.
- `listModels()`
  - Returns providers/models for settings and session model picker validation.
  - Each provider must include `provider`, `isAvailable`, `availabilitySource`, `availabilitySources`, and `models`.
  - Each model must include `id`, `name`, `reasoning`, `contextWindow`, and `maxTokens`.
- `ask(params)`
  - One-shot utility call used by task generation and branch naming.
  - Must honor `cwd`, `prompt`, optional `model`, optional `thinkingLevel`, optional `systemPrompt`, and best-effort `timeoutMs`.
  - Should return plain assistant text with no UI events.
- `createRuntime(params)`
  - Builds an `AgentRuntime` for a Reins session.
  - Receives project/task context, selected model/thinking level, runtime tools, and `resume`.

## `createRuntime` inputs the adapter must respect

`CreateAgentRuntimeParams` includes:

- `state`, `projectId`, `projectDir`, `sessionId`
- `task` — non-null for task sessions; the session manager has already checked out the task branch.
- `model` — persisted or selected model identity for this runtime.
- `thinkingLevel` — Reins thinking level (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) or `null`.
- `sessionTools`
  - `builtins`: currently `read`, `write`, `edit`, `bash`.
  - `customTools`: Reins tools (`create_task`, `search`, `execute`). Session orchestration is exposed through `api.sessions` in execute.
- `resume`
  - Legacy adapter input retained only by the unregistered Claude implementation.
  - AgentHarness reopens its lane and active branch directly from canonical storage.

A runtime should build the Reins system prompt with project/task context and available tools. Existing runtimes use `buildReinsSystemPrompt()` plus resource loading for AGENTS/context/skills where applicable.

## Minimum viable `AgentRuntime`

A runtime returned from `createRuntime()` must implement:

- `prompt(content, options?): Promise<RuntimePromptSubmission>`
  - Durably records a canonical AgentHarness prompt operation, starts execution in the background, and returns its exact message identity without waiting for the response.
  - Text-only prompts are represented as `[{ type: "text", text }]`; prompt images are attachment refs that the runtime hydrates at the provider boundary.
  - Optional `reinsId`, metadata, and timestamp are stored with the admitted input. Admission failures reject; later execution failures are reported through terminal events and logging.
  - Must update `isStreaming()` while running.
- `waitForIdle(): Promise<void>`
  - Observes AgentHarness lane operation settlement, including steering, retry, and compaction.
  - Waiting never aborts work. The model/API layer bounds individual waits and handles waiter cancellation separately.
- `steer(content): Promise<void>`
  - Called when the user submits validated `RuntimePromptContent` while streaming.
  - AgentHarness forwards to its active operation. Never add a Reins delivery wait, follow-up queue, or abort/restart fallback.
- `abort(): Promise<void>`
  - Cancels the active prompt and aborts active tool execution where possible; discard pending native steering messages.
- `setModel({ provider, modelId, thinkingLevel }): Promise<void>`
  - Applies live model changes for an already-open runtime.
  - If runtime-native live switching is unsupported, store for next turn or reject clearly.
- `subscribe(listener): () => void`
  - Registers a listener for normalized `AgentRuntimeEvent` values and returns an unsubscribe function.
  - Adapters must explicitly map supported native events; unchecked vendor-event pass-through is not part of the contract.
  - Events drive both frontend streaming and persistence checkpoints.
- `getMessages(): Promise<AgentRuntimeMessage[]>`
  - Projects the current active AgentHarness branch into Reins-normalized messages for UI outcomes and parent reports.
  - It is not a persistence source; canonical entries are already durable.
- Optional `getLastRunOutcome()`
  - Reads the latest durable native terminal run identity, status, and error. AgentHarness resolves it from lane operation storage, so live session waits do not depend on an adapter-local outcome cache or transcript inference.
- `isStreaming(): boolean`
  - Used by routes, health checks, idle eviction, task deletion guards, and frontend session state. Reflect active AgentHarness operations, including compaction and steering, not only token streaming.
- `close(): Promise<void>`
  - Releases subprocesses, SDK handles, streams, MCP servers, and listeners.
- Optional `getSessionMetadata()`
  - Used after `agent_end` to persist current model/thinking metadata when the runtime can report it.

## Minimum event contract

Events are `AgentRuntimeEvent` values from `runtimes/registry.ts`.

### Required for basic UX

- `agent_start`
  - Emit as soon as a run is accepted/started so the UI shows streaming state.
- `message_start`, `message_update`, and `message_end`
  - Every event carries the complete current Reins-normalized message snapshot. For assistant messages, keep the same numeric `message.timestamp` throughout the lifecycle and in persistence.
  - Emit `message_update` whenever assistant content changes. Provider delta metadata may remain in `assistantMessageEvent`, but consumers must not need it to reconstruct content.
  - Pi provides full snapshots natively. Adapters for delta-only providers must accumulate provider deltas and synthesize the normalized snapshot before emitting each update.
- `agent_end`
  - The terminal runtime activity boundary. AgentHarness maps its durable `run_end`, which occurs after automatic retry, deferred polling, steering, and automatic compaction.
  - Include `messages` produced during this run (not necessarily the full transcript) so the frontend can append final assistant/tool messages.
  - Preserve native terminal data when available: `runId`, `status` (`completed`, `failed`, or `aborted`), and structured `error`. Consumers should prefer this outcome over inferring failure from the transcript.

### Required for lifecycle state

Canonical transcript persistence does not depend on runtime events. AgentHarness storage commits entries directly. The lifecycle observer uses start and settlement events to update activity state and persist final model/thinking metadata.

### Required for tool UI

For useful tool rendering, emit:

- `tool_execution_start` with stable `toolCallId`, canonical `toolName`, and `args`.
- `tool_execution_update` for progress, when available.
- `tool_execution_end` with the same `toolCallId`, `toolName`, optional `result`, and `isError`. When present, `result` should use `{ content: RuntimeContentBlock[], details?: Record<string, unknown> }` so Reins can externalize inline image blocks before broadcasting.

Tool names should be normalized to Reins names where possible (`read`, `write`, `edit`, `bash`, `create_task`, `delegate`, `search`, `execute`) so existing frontend renderers work.

### Recommended lifecycle events

- `turn_start`, `turn_end`
  - Useful for pi compatibility and mid-loop persistence.
  - Pi also emits message lifecycles for user and tool-result messages. Consumers must inspect `message.role`; only assistant lifecycles belong in assistant streaming state.
- `compaction_start`, `compaction_end`
  - Required if the runtime performs context compaction/summarization.
  - `compaction_start` may occur before `agent_start` for runtimes that compact before entering the agent loop for a new turn. Reins treats it as active session work.
  - Compaction is not an activity completion boundary. AgentHarness emits its terminal `run_end` only after automatic compaction and any retry work has durably completed.
- `auto_retry_start`, `auto_retry_end`
  - Optional UI diagnostics for retrying runtimes.

## Message shape contract

`getMessages()` must return `AgentRuntimeMessage[]` in Reins-normalized form:

- User message:
  - `role: "user"`
  - `content`: block-only content, usually `[{ type: "text", text }]`; prompt images use attachment refs in persisted/client form and inline base64 only at provider boundaries.
  - `timestamp` recommended for frontend dedupe.
- Assistant message:
  - `role: "assistant"`
  - `content`: blocks with:
    - `{ type: "text", text }`
    - `{ type: "thinking", thinking, thinkingSignature? }`
    - `{ type: "toolCall", id, name, arguments }`
  - `stopReason` optional.
  - `timestamp` required and stable across that assistant message's lifecycle events and persisted form.
- Tool result:
  - `role: "toolResult"`
  - `toolCallId`, `toolName`, `content`, `isError`, `timestamp`.
- Compaction summary:
  - `role: "compactionSummary"`
  - `summary` contains the compacted context; do not also set `content`.

Reins input messages use the supported custom `reinsInput` role in canonical storage. They carry a stable `reinsId` and application-owned `metadata` supplied at durable prompt submission. Provider projection strips both fields and converts the entry to an ordinary user message.

Normalized application projections use `logicalId` for the exact AgentHarness entry identity. Metadata is never reconstructed from timestamps, provider response IDs, tool-call IDs, content, or position, and there is no post-hoc metadata mutation API.

## Tool integration expectations

A replacement runtime must expose Reins tools to the model somehow:

- Built-in coding tools: `read`, `write`, `edit`, `bash`.
- Custom tools: `create_task`, `search`, `execute`.

The registered AgentHarness Pi runtime uses AgentHarness-native built-ins and Reins application tools directly. Its read/write/edit/bash tools share a cwd-scoped `NodeExecutionEnv`; bash adds live session/model/reasoning environment values in its native prepare hook, and runtime shutdown cleans up the environment. Reins application tools use the native harness execution signature and cancellation context without custom durable checkpoints. The unregistered Claude SDK implementation retains isolated legacy tool conversion for later cleanup or reintegration.

If a runtime cannot expose custom tools, task creation/session orchestration/search/execute will not be available to agents running through it.

## Asynchronous session orchestration

`api.sessions.start(prompt, options)` materializes a normal session and starts `runtime.prompt()` without waiting for its response, returning `{ sessionId }`. Background prompt failures are logged. `options.parentSessionId` is explicitly `"current"` (child) or `null` (independent); creation stays in the caller's project/task. Optional titles reuse `sessions.name`; omitted titles leave normal naming unchanged. Children retain the depth limit of three. Prompts are not prefixed with an artificial delegation preamble.

`api.sessions.send(sessionId, message)` reopens the existing session if needed. Idle sessions start a normal prompt; busy sessions receive native `steer()`. Unsupported steering rejects immediately. There is no mode parameter, queued follow-up operation, hidden waiting/retry, or cancellation/restart fallback. Explicit abort remains separate.

`api.sessions.wait(sessionId, timeoutMs?)` observes the entire session until settled, then returns its latest response/outcome. It waits through native idleness, reads the durable native run outcome when available, and rechecks runtime activity before returning. Waits are bounded to 0–30,000 ms (default 10,000); timeout or execute-tool abort stops only the observation. Self-waits are rejected. Closed sessions are read directly from persisted history without opening an LLM runtime.

There are no receipts, unsent-message tables, dispatchers, or parallel Reins execution state machines. AgentHarness operations are the durable work identity:

- Prompt acceptance commits the `reinsInput` metadata and harness operation before provider execution begins.
- Steering targets the active AgentHarness operation directly; native errors propagate.
- Explicit abort and retry behavior remain owned by AgentHarness. Reopened operations remain passive until explicitly driven. Once a runtime is evicted, waits inspect canonical active-branch outcomes but cannot reconstruct transient execution errors.
- The unregistered Claude implementation is not part of current orchestration guarantees.
- The session manager coalesces concurrent opens using `ServerState.sessionOpenings`, avoiding duplicate runtimes for simultaneous sends. This and the runtime map survive handler hot reloads. Creating sibling sessions on the active task branch skips redundant Git checkouts, so session creation does not contend for the checkout/index lock.

Sessions share the existing checkout. No project-wide lock is held across execution or nested waits; agents must coordinate file edits. Parent links do not propagate cancellation. Historical delegate transcripts and frontend renderers remain readable.

### Child settlement reports

The separate `runtime-parent-report-observer.ts` subscriber reacts to terminal `agent_end`. It is attached after the synchronous lifecycle observer, then reads the child's latest output. The report uses the authoritative normalized terminal status/error when AgentHarness provides it, rather than inferring those fields from the transcript. Lifecycle observation does not invoke or await reporting. The subscriber calls `SessionMessages.send` for the parent, checking the same project/task scope. Reports are labelled structured JSON carried as normal text input—not new user authorization.

`models/session-messages.ts` owns addressed delivery: opening the target, idle prompting versus busy native steering, activity touch and broadcast. The scoped functions in `models/session-operations.ts` and the parent reporter share this module; a future HTTP caller can use it without duplicating delivery logic. Authorization belongs to callers. No HTTP route is added.

There is no prompt-promise wrapper, extra busy tracking, inbox, dispatcher, or receipt layer. Reports durably accept an idle-parent prompt or steer a busy parent immediately. Delivery errors are logged by the reporting subscriber and are not retried; they do not affect lifecycle updates. Reopening alone emits no settlement and produces no report; follow-up settlement reports again. Only outcomes represented by the active branch at settlement are reported; startup failures without a settlement event do not produce a report. Pending callbacks are not recovered after restart.

## Resume and persistence expectations

Reins SQLite is the canonical transcript and AgentHarness state store. `PiStorageAdapter` implements the harness storage contract, including entries, ancestry, lane values, lists, and usage. Runtime-private replay files are not a second source of truth.

Opening a session reconstructs AgentHarness directly from canonical storage. `getMessages()` projects active branch context for application readers; it never feeds a snapshot writer. See [Session Message Persistence](session-message-persistence.md).

## Conversation forking expectations

See [ADR-006](../adr/006-acpx-as-runtime-replacement.md) for the decision behind this requirement.

Conversation forking is not part of the current `AgentRuntime` interface, but any runtime that should support Reins conversation trees must provide one of these capabilities:

1. **Native fork** — fork the runtime's internal conversation/session at a known point and continue on the new branch.
2. **Prefix hydration** — create a fresh runtime session whose model context is exactly a supplied prefix of Reins-normalized messages.
3. **Prompt approximation** — create a fresh session and paste a transcript/summary into the next prompt. This is useful as a fallback, but it is not equivalent to real forking because tool calls/results and provider-specific state are not restored structurally.

For a true fork, Reins needs the runtime to continue from an arbitrary persisted prefix, not just resume the runtime's latest saved session. That implies an adapter API beyond today's `resume: true`, for example a future `forkFromMessages(prefixMessages)` or `createRuntime({ initialMessages })` contract.

AgentHarness already stores tree-shaped entry ancestry and selects context through a lane branch tip. A future runtime adapter is not sufficient for true forking unless it can preserve equivalent ancestry or import an exact arbitrary transcript prefix.

## Model/runtime UX expectations

Reins stores runtime identity separately from provider/model identity:

- Runtime: `agent_runtime_type`
- Model identity: `model_provider`, `model_id`

The adapter's `listModels()` defines what the frontend can select for that runtime. Existing session runtime switching is only allowed before any messages are persisted.

The Pi adapter uses Pi's `ModelRuntime` as the canonical provider/model catalog and request-auth boundary. Model-list requests permit Pi's bounded remote catalog refresh and retain Pi's on-disk catalog cache, while session creation restores that cache without adding startup network latency. Reins supplies a `CredentialStore` backed directly by SQLite, so API keys, OAuth refreshes, and active sessions all share the same persisted credentials without an auth-reload compatibility layer. Reins model identities remain only provider/model references; no model declarations are maintained in Reins.

## Could acpx replace all current runtimes?

No — see [ADR-006](../adr/006-acpx-as-runtime-replacement.md). We rejected acpx as a universal runtime replacement.

acpx could still be useful as an opt-in adapter or as lower-level ACP plumbing. It owns useful concerns such as ACP process launch, session new/load/prompt/cancel, client filesystem/terminal handlers, auth handshake, and agent command presets.

But acpx does not replace:

- The Reins `AgentRuntime` contract.
- Event/message translation into Reins shapes.
- Conversation forking/prefix hydration.
- Reins custom tool exposure.
- Reins model picker/catalog semantics.
- Reins SQLite persistence and resume semantics.
- Reins system prompt/resource/skill behavior.

So the practical path, if we use acpx at all, is an opt-in `acpx` runtime adapter that translates ACP/acpx into this contract. It should not become the canonical runtime boundary.
