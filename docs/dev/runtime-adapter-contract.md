# Runtime Adapter Contract

This document describes the minimum contract a Reins runtime adapter must satisfy.
It is based on the current `packages/backend/src/runtimes/` code and the frontend event consumers.

## Where runtimes plug in

Runtime adapters are registered with `registerRuntimeAdapter()` and selected by the session row's `agent_runtime_type`.

The orchestration path is:

1. `runtimes/sessions-manager.ts` creates or reopens a Reins session.
2. `createAgentRuntime(runtimeType, ...)` finds the adapter.
3. The adapter builds an `AgentRuntime` for the project/session/task.
4. Runtime events are broadcast to the frontend and observed for persistence.
5. The persistence observer snapshots `runtime.getMessages()` on checkpoint events.

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
  - `true` when SQLite already has persisted messages for the session.
  - Runtime must hydrate or otherwise continue from Reins persisted history.

A runtime should build the Reins system prompt with project/task context and available tools. Existing runtimes use `buildReinsSystemPrompt()` plus resource loading for AGENTS/context/skills where applicable.

## Minimum viable `AgentRuntime`

A runtime returned from `createRuntime()` must implement:

- `prompt(content): Promise<void>`
  - Starts a user turn from `RuntimePromptContent` (`runtimes/registry.ts`) and resolves only when the run is complete or failed.
  - Text-only prompts are represented as `[{ type: "text", text }]`; prompt images are attachment refs that the runtime hydrates at the provider boundary.
  - Must reject on fatal prompt failures so the initiating WS client sees an error.
  - Must update `isStreaming()` while running.
- `queue(content): Promise<void>`
  - Admits a follow-up without waiting for response completion; starts an idle runtime.
  - While busy, delivers only after the current work finishes, not at a steering point. Runtimes without supported busy queueing must reject explicitly.
  - Prefer native queues; do not emulate missing queue/settlement capabilities with a Reins scheduler.
- `waitForIdle(): Promise<void>`
  - Observes runtime-native idleness, including native follow-ups, steering, retry and compaction—not `agent_end` alone.
  - Pi delegates directly to native `waitForIdle()`. Its async preflight can still report idle; this limitation is not masked by retaining prompt promises or adding busy-state guards.
  - Outcomes come from the latest transcript and any native wait error. Prompt failures are reported to the initiating caller (or logged for background starts), not necessarily replayed by later waits. Adapters with cancellation signals may reject with `AbortError`.
  - Waiting never aborts work. The model/API layer bounds individual waits and handles waiter cancellation separately.
- `steer(content): Promise<void>`
  - Called when the user submits validated `RuntimePromptContent` while streaming.
  - If unsupported, reject with a clear error. Claude SDK currently does this.
- `abort(): Promise<void>`
  - Cancels the active prompt and aborts active tool execution where possible; discard pending queued follow-ups.
- `setModel({ provider, modelId, thinkingLevel }): Promise<void>`
  - Applies live model changes for an already-open runtime.
  - If runtime-native live switching is unsupported, store for next turn or reject clearly.
- `subscribe(listener): () => void`
  - Registers a listener for normalized `AgentRuntimeEvent` values and returns an unsubscribe function.
  - Adapters must explicitly map supported native events; unchecked vendor-event pass-through is not part of the contract.
  - Events drive both frontend streaming and persistence checkpoints.
- Optional `activityCompletionBoundary: "agent_end" | "agent_settled"`
  - Defaults to `agent_end`. Opt into `agent_settled` only when the runtime has an outer lifecycle that remains active after its inner agent run ends.
  - Pi opts into `agent_settled`; Claude SDK and runtimes without this property retain existing `agent_end`/terminal-compaction completion behavior.
- `getMessages(): Promise<AgentRuntimeMessage[]>`
  - Returns the full current Reins-normalized transcript for persistence/LLM resume.
  - This is the source of truth used by `runtime-persistence-observer.ts`.
- `isStreaming(): boolean`
  - Used by routes, health checks, idle eviction, task deletion guards, and frontend session state. Reflect native runtime activity, including compaction and queued work, not only active token streaming. Pi uses `!session.isIdle`; it does not add synthetic activity for preflight.
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
  - Emit when the inner agent run is complete.
  - Include `messages` produced during this run (not necessarily the full transcript) so the frontend can append final assistant/tool messages.
- `agent_settled`
  - A normalized terminal event for runtimes whose outer prompt can continue automatically after `agent_end` (for example through threshold compaction or retry).
  - Required when `activityCompletionBoundary` is `agent_settled`; it marks activity finished but is not a transcript persistence checkpoint.

### Required for persistence

The persistence observer snapshots `getMessages()` when it sees any of:

- `turn_end`
- `agent_end`
- `compaction_end` with `aborted !== true`

A minimal runtime can persist only on `agent_end`, but should emit `turn_end` when the underlying agent has internal turn boundaries or long tool loops.

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
  - Set `compaction_end.willRetry` when known. For default runtimes, `willRetry: false` is terminal. For settlement-aware runtimes, successful automatic compaction remains active until `agent_settled`.
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

Persistence filters empty assistant error messages (`role="assistant"`, `stopReason="error"`, empty `content`) so runtimes may emit those only as transient UI error carriers.

## Tool integration expectations

A replacement runtime must expose Reins tools to the model somehow:

- Built-in coding tools: `read`, `write`, `edit`, `bash`.
- Custom tools: `create_task`, `search`, `execute`.

The adapter is responsible for converting Reins `ToolDefinition`s into the runtime-native tool format. Examples today:

- Pi consumes the Pi `customTools` directly.
- Claude SDK exposes custom tools through an SDK MCP server.

If a runtime cannot expose custom tools, task creation/session orchestration/search/execute will not be available to agents running through it.

## Asynchronous session orchestration

`api.sessions.start(prompt, options)` materializes a normal session and calls `runtime.queue()`, returning `{ sessionId }` after admission rather than after the response. `options.parentSessionId` is explicitly `"current"` (child) or `null` (independent); creation stays in the caller's project/task. Optional titles reuse `sessions.name`; omitted titles leave normal naming unchanged. Children retain the depth limit of three. Prompts are not prefixed with an artificial delegation preamble.

`api.sessions.send(sessionId, message, mode)` reopens the existing session if needed. Busy `steer` calls native `steer()` and propagates unsupported-steering errors; all `queue` requests and idle requests of either mode use `queue()`. There is no cancellation/restart fallback.

`api.sessions.wait(sessionId, timeoutMs?)` observes the entire session until settled, then returns its latest response/outcome. It waits through the runtime's native settlement and the persistence observer's checkpoint queue, rechecking runtime activity before returning. Waits are bounded to 0–30,000 ms (default 10,000); timeout or execute-tool abort stops only the observation. Self-waits are rejected. Closed sessions are read directly from persisted history without opening an LLM runtime.

There are no receipts, run IDs, new tables, or managed-session execution state machines. Adapters own live work:

- Pi uses native `followUp`, `steer`, `waitForIdle`, and busy/idle flags directly. `prompt()` is an ordinary async SDK call; no completion promise, payload queue, or startup/settlement guard is retained. Idle sends start work without waiting for the response; background prompt rejections are logged. During standalone compaction, sends await native `waitForIdle()` and recheck streaming before choosing prompt versus native queue/steer delivery. No compaction rejection, interruption, or additional execution queue is introduced. Pi can report idle during async preflight or before the outer prompt promise finishes; immediate waits may return before new work begins, and concurrent startup sends are not serialized by Reins. This is an explicit native limitation, not a stronger admission/settlement guarantee.
- Claude accepts one outstanding prompt. Busy queue and steer requests reject explicitly; idle requests still start work. The existing SDK input stream remains transport plumbing, not a response-gated execution queue. Existing prompt completion and tool abort state provide settlement/error/cancellation information. Native Claude can merge inputs, and its SDK lacks a verified all-inputs settlement barrier, so Reins does not emulate busy queueing.
- Explicit abort clears Pi's native queue. Native retry/error handling otherwise stays with the SDK. No queued work is replayed after process restart. Once a runtime is evicted, waits can inspect persisted transcript outcomes but cannot reconstruct transient execution errors.
- The session manager coalesces concurrent opens using `ServerState.sessionOpenings`, avoiding duplicate runtimes for simultaneous sends. This and the runtime map survive handler hot reloads. Creating sibling sessions on the active task branch skips redundant Git checkouts, so session creation does not contend for the checkout/index lock.

Sessions share the existing checkout. No project-wide lock is held across execution or nested waits; agents must coordinate file edits. Parent links do not propagate cancellation or automatically inject results/wake parents. Historical delegate transcripts and frontend renderers remain readable.

## Resume and persistence expectations

Reins SQLite is the canonical Reins transcript store. Runtime-private files may exist, but the adapter must not depend on them as the only source of truth.

On `resume: true`, the runtime should hydrate from `loadMessagesForLLM(sessionId)` or equivalent Reins persistence, including the last compaction summary boundary.

On each checkpoint event, `getMessages()` should return the complete current transcript in stable order. The persistence observer appends ordinary growth, reconciles failed assistant responses replaced by runtime retries, and handles compaction pruning. See [Session Message Persistence](session-message-persistence.md).

## Conversation forking expectations

See [ADR-006](../adr/006-acpx-as-runtime-replacement.md) for the decision behind this requirement.

Conversation forking is not part of the current `AgentRuntime` interface, but any runtime that should support Reins conversation trees must provide one of these capabilities:

1. **Native fork** — fork the runtime's internal conversation/session at a known point and continue on the new branch.
2. **Prefix hydration** — create a fresh runtime session whose model context is exactly a supplied prefix of Reins-normalized messages.
3. **Prompt approximation** — create a fresh session and paste a transcript/summary into the next prompt. This is useful as a fallback, but it is not equivalent to real forking because tool calls/results and provider-specific state are not restored structurally.

For a true fork, Reins needs the runtime to continue from an arbitrary persisted prefix, not just resume the runtime's latest saved session. That implies an adapter API beyond today's `resume: true`, for example a future `forkFromMessages(prefixMessages)` or `createRuntime({ initialMessages })` contract.

Pi is closest today because its session manager is tree-shaped and can build context from a branch. Claude Code may be viable through its SDK/session-store path if we can load a synthetic prefix as the session history. A generic ACP/acpx adapter is not enough unless ACP `session/fork` exists for the target agent or the adapter can import an arbitrary transcript prefix.

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
