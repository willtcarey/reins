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
  - `customTools`: Reins tools (`create_task`, `delegate`, `search`, `execute`; `delegate` only for task sessions).
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
- `steer(content): Promise<void>`
  - Called when the user submits validated `RuntimePromptContent` while streaming.
  - If unsupported, reject with a clear error. Claude SDK currently does this.
- `abort(): Promise<void>`
  - Cancels the active prompt and aborts active tool execution where possible.
- `setModel({ provider, modelId, thinkingLevel }): Promise<void>`
  - Applies live model changes for an already-open runtime.
  - If runtime-native live switching is unsupported, store for next turn or reject clearly.
- `subscribe(listener): () => void`
  - Registers a listener for `AgentRuntimeEvent` and returns an unsubscribe function.
  - Events drive both frontend streaming and persistence checkpoints.
- `getMessages(): Promise<AgentRuntimeMessage[]>`
  - Returns the full current Reins-normalized transcript for persistence/LLM resume.
  - This is the source of truth used by `runtime-persistence-observer.ts`.
- `isStreaming(): boolean`
  - Used by routes, health checks, idle eviction, task deletion guards, and frontend session state.
- `close(): Promise<void>`
  - Releases subprocesses, SDK handles, streams, MCP servers, and listeners.
- Optional `getSessionMetadata()`
  - Used after `agent_end` to persist current model/thinking metadata when the runtime can report it.

## Minimum event contract

Events are `AgentRuntimeEvent` values from `runtimes/registry.ts`.

### Required for basic UX

- `agent_start`
  - Emit as soon as a run is accepted/started so the UI shows streaming state.
- `message_update`
  - For text streaming, set `assistantMessageEvent.type = "text_delta"` and `delta` to the appended text.
- `agent_end`
  - Emit when the run is complete.
  - Include `messages` produced during this run (not necessarily the full transcript) so the frontend can append final assistant/tool messages.

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

- `turn_start`, `message_start`, `message_end`, `turn_end`
  - Useful for pi compatibility and mid-loop persistence.
- `compaction_start`, `compaction_end`
  - Required if the runtime performs context compaction/summarization.
  - `compaction_start` may occur before `agent_start` for runtimes that compact before entering the agent loop for a new turn. Reins treats it as active session work.
  - Set `compaction_end.willRetry` when known. `willRetry: true` means active work will continue after compaction; `willRetry: false` means compaction is terminal and Reins should not wait for a later `agent_end` to clear activity.
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
  - `timestamp` recommended.
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
- Custom tools: `create_task`, `delegate`, `search`, `execute`.

The adapter is responsible for converting Reins `ToolDefinition`s into the runtime-native tool format. Examples today:

- Pi consumes the Pi `customTools` directly.
- Claude SDK exposes custom tools through an SDK MCP server.

If a runtime cannot expose custom tools, task creation/delegation/search/execute will not be available to agents running through it.

## Resume and persistence expectations

Reins SQLite is the canonical Reins transcript store. Runtime-private files may exist, but the adapter must not depend on them as the only source of truth.

On `resume: true`, the runtime should hydrate from `loadMessagesForLLM(sessionId)` or equivalent Reins persistence, including the last compaction summary boundary.

On each checkpoint event, `getMessages()` should return the complete current transcript in stable order. The persistence observer will append/dedupe and handle compaction pruning.

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
