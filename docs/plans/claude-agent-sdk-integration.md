# Claude Agent SDK Integration Plan

## Goal

Integrate the Claude Agent SDK as a first-class agent runtime in Reins, alongside the existing pi runtime. The SDK handles auth, API transport, tool execution, session persistence, and turn management. Reins provides the UI, custom tools, system prompt, and session metadata.

## Background

Currently Reins uses pi's agent loop exclusively:
- `streamSimple` makes one LLM API call per turn
- Pi's `agentLoop` manages the turn cycle: LLM call → tool execution → feed results → repeat
- Pi handles tool execution, message persistence, compaction, steering

The previous `claude-agent-sdk` v1 extension (formerly at `packages/backend/src/pi/vendor/claude-agent-sdk-pi.ts`) used the SDK purely as an inference backend within pi's turn loop. It serialized the full conversation as text into a single prompt, denied all SDK tool execution, and mapped stream events back to pi's format. That approach had limitations:
- Tool results were text-serialized (no structured `tool_result` messages)
- Each turn spawned a new `query()` — no session continuity in the SDK
- MCP workarounds for custom tool schemas

That legacy extension has now been removed from Reins. The new approach lets the SDK own the full agent loop while Reins wraps it.

## Architecture

### Model identity vs execution runtime

Session model selection and runtime are separate concerns and should be stored separately:

- **Model identity**: `model_provider` + `model_id` (what model is selected)
- **Execution runtime**: `agent_runtime_type` (how turns execute)

Naming convention:
- In code: `AgentRuntime` interface (live runtime object)
- In DB: `agent_runtime_type` column (persisted runtime discriminator)

This avoids overloading provider names with runtime behavior. Example:

- Anthropic model through pi API path: `model_provider=anthropic`, `agent_runtime_type=pi`
- Anthropic model through Claude Code SDK path: `model_provider=anthropic`, `agent_runtime_type=claude_agent_sdk`

### Runtime-based routing

When a session starts/resumes, Reins resolves the session row and dispatches by `agent_runtime_type`:

```
agent_runtime_type: "pi"                → PiAgentRuntime
agent_runtime_type: "claude_agent_sdk"  → ClaudeSdkAgentRuntime
```

`agent_runtime_type` is persisted on the session row and is immutable for the life of the session. Runtime routing should always use this persisted value as the source of truth (no inference from provider/model IDs).

The frontend model picker still works in terms of provider/model selection, but for an existing session it must be scoped to models exposed by that session's runtime.

### Runtime adapters own model resolution

Not all runtimes will source models from the same registry. Reins should treat `model_provider` + `model_id` as the only cross-runtime model primitive, and let each runtime adapter resolve that pair into its own native model type.

Proposed adapter contract:

```typescript
interface AgentRuntimeAdapter {
  runtimeType: AgentRuntimeType;
  listModels(): Promise<ProviderInfo[]>;
  resolveModel(params: { cwd: string; provider: string; modelId: string }): Promise<ResolvedRuntimeModel>;
  createRuntime(params: {
    sessionId: string;
    projectId: number;
    projectDir: string;
    taskId: number | null;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: ThinkingLevel;
  }): Promise<AgentRuntime>;
}
```

Shared model catalog contract for runtime adapters:

```typescript
interface ProviderInfo {
  provider: string;
  isAvailable: boolean;
  availabilitySource: "db" | "env" | "oauth" | "local" | null;
  availabilitySources: ("db" | "env" | "oauth" | "local")[];
  models: ModelInfo[];
}

interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}
```

Notes:
- `ResolvedRuntimeModel` is intentionally runtime-specific/opaque (e.g. pi `Model<Api>`, SDK-native model handle, etc.).
- Session orchestration persists only provider/id/runtime type; it does not persist runtime-native model objects.
- `listModels()` is runtime-local, so model discovery can come from pi registry, Claude SDK APIs, or other sources without coupling.
- `ProviderInfo`/`ModelInfo` for `listModels()` should be owned by `runtimes/registry.ts` (shared runtime contract), not by the pi runtime package.
- Rename provider availability fields to runtime-agnostic naming: `hasKey` → `isAvailable`, `keySource` → `availabilitySource`, `keySources` → `availabilitySources`.

### Runtime code organization

Organize runtime implementations under `packages/backend/src/runtimes/`:

- `runtimes/pi/` — pi runtime adapter + runtime implementation
- `runtimes/claude_agent_sdk/` — Claude Code SDK runtime adapter + runtime implementation
- `runtimes/registry.ts` — adapter registration + lookup by `agent_runtime_type`

`registry.ts` should:
- export `AgentRuntimeType`
- export `AgentRuntimeAdapter`
- maintain a single adapter map (runtime type → adapter)
- expose helper APIs like `getRuntimeAdapter(type)` and `createAgentRuntime(...)`

### What each layer owns

| Concern | Pi runtime | Claude SDK runtime |
|---|---|---|
| Agent loop | Pi's `agentLoop` | SDK's `query()` |
| Tool execution | Pi's `AgentTool.execute()` | SDK built-ins (Read/Write/Edit/Bash/Grep/Glob) + MCP for custom tools |
| Session persistence | Reins SQLite (messages) | SDK JSONL files (`~/.claude/projects/`) |
| Session metadata | Reins SQLite | Reins SQLite (project/task links, model config, runtime) |
| Session resume | `hydrateSessionManager` + `replaceMessages` | SDK's `resume: sessionId` option |
| System prompt | Pi's `buildReinsSystemPrompt()` | Same prompt, passed via SDK's `systemPrompt` option |
| Events → frontend | `AgentSessionEvent` via `agentSession.subscribe()` | `SDKMessage` mapped to compatible broadcast format |
| Compaction | Pi's `SessionManager` | SDK handles internally |
| Message display | Load from SQLite | `getSessionMessages(sessionId)` from SDK |

### Session interface

`ManagedSession` should be runtime-agnostic. Keep only lifecycle metadata and a runtime handle:

```typescript
interface AgentRuntime {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  getMessages(): Promise<ReinsMessage[]>;
  close(): Promise<void>;
}

interface ManagedSession {
  id: string;
  lastActivity: number;
  runtime: AgentRuntime;
}
```

Implementation classes:
- `PiAgentRuntime`
- `ClaudeSdkAgentRuntime`

`ws.ts` calls `managed.runtime.prompt/steer/abort` without runtime-specific branching.

### Tool registration

**Built-in tools** (Read, Write, Edit, Bash, Grep, Glob): SDK executes these natively via Claude Code's CLI. No pi involvement.

**Custom tools** (create_task, delegate, search, execute): Registered via `createSdkMcpServer()` with handlers that call the actual tool executors. The model sees these as `mcp__custom-tools__<name>` (e.g., `mcp__custom-tools__create_task`) because MCP naming is SDK-defined. Reins should normalize tool names back to canonical Reins names at the message persistence/API boundary so stored/displayed tool calls remain runtime-agnostic (`create_task`, `delegate`, etc.).

```typescript
const mcpTools = customTools.map(tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
  handler: async (args) => {
    const result = await tool.execute(toolCallId, args, signal);
    return { content: [{ type: "text", text: formatResult(result) }] };
  },
}));

const server = createSdkMcpServer({
  name: "custom-tools",
  version: "1.0.0",
  tools: mcpTools,
});
```

### Event mapping

SDK stream events (`SDKMessage`) are mapped to Reins' broadcast format for WebSocket clients:

| SDK event | Reins broadcast |
|---|---|
| `stream_event` → `message_start` | `{ type: "event", event: { type: "turn_start" } }` |
| `stream_event` → `content_block_start` (text) | `{ type: "event", event: { type: "message_start", message: ... } }` |
| `stream_event` → `content_block_delta` (text) | `{ type: "event", event: { type: "message_update", ... } }` |
| `stream_event` → `content_block_stop` (text) | `{ type: "event", event: { type: "message_end", ... } }` |
| `stream_event` → `content_block_start` (tool_use) | `{ type: "event", event: { type: "message_update", ... } }` (tool call in content) |
| `tool_progress` | `{ type: "event", event: { type: "tool_execution_update", ... } }` |
| PostToolUse hook | `{ type: "event", event: { type: "tool_execution_end", ... } }` |
| `stream_event` → `message_stop` (with tool calls) | `{ type: "event", event: { type: "turn_end", ... } }` |
| `stream_event` → `message_start` (next turn) | `{ type: "event", event: { type: "turn_start" } }` |
| `result` | `{ type: "event", event: { type: "agent_end", ... } }` |

### SDK query options

```typescript
query({
  prompt,
  options: {
    cwd: projectDir,
    sessionId: reinsSessionId,           // correlate with SQLite
    resume: existingSessionId,           // for resumed sessions

    // Tools
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    mcpServers: { "custom-tools": mcpServer },

    // Permissions — everything open
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,

    // System prompt — Reins' prompt, not Claude Code preset
    systemPrompt: buildReinsSystemPrompt({ tools, task }),

    // Streaming
    includePartialMessages: true,

    // Persistence — SDK handles it
    persistSession: true,

    // Settings — don't load Claude Code's settings files
    settingSources: [],
    strictMcpConfig: true,

    // Thinking
    thinking: { type: "adaptive" },  // or budget-based for older models
    effort: mapThinkingLevel(thinkingLevel),

    // Hooks for capturing tool results
    hooks: {
      PostToolUse: [{ hooks: [postToolUseHandler] }],
      PreToolUse: [{ hooks: [preToolUseHandler] }],
    },
  },
});
```

### Session lifecycle

**Create:**
1. Generate session UUID
2. Create SQLite row with metadata (project, task, model, thinking level, runtime type)
3. Build runtime via `createAgentRuntime({ agentRuntimeType, ...context })`
4. Start runtime loop and stream events → broadcast to WebSocket clients
5. On `result` or abort → update SQLite metadata

**Resume:**
1. Look up session in SQLite → get session UUID, project, and `agent_runtime_type`
2. Build runtime via `createAgentRuntime(...)`
3. Resume streaming events
4. For message history display: `managed.runtime.getMessages()`

**Idle eviction:**
1. Session remains warm in memory for a short inactivity window (same pattern as pi)
2. On eviction, call `managed.runtime.close()` to clean up runtime resources
3. Remove session from in-memory registry
4. Later prompts recreate runtime via normal resume flow

**Display messages:**
- Claude SDK runtime: `getSessionMessages(sessionId)` → transform to Reins' message format
- Pi runtime: load from SQLite (existing path)

## Implementation phases

### Delivery strategy: non-breaking migration with restart-safe checkpoints

We will not do a big-bang switch. The rollout is intentionally additive and should stay bootable after every phase:

- Keep `pi` as the default runtime path while refactoring.
- Keep schema changes additive (add columns/tables; avoid destructive renames/drops in this migration).
- Migrate call sites incrementally so server restarts can be verified at each checkpoint.
- Preserve runtime immutability per session so existing sessions cannot be accidentally rerouted.
- Treat "server boots + pi sessions still work" as a hard gate before introducing Claude-runtime traffic.

### Phase 1: Additive runtime metadata

Status: ✅ Complete

- [x] Add `agent_runtime_type` to `sessions` with default `"pi"`.
- [x] Backfill existing rows to `"pi"`.
- [x] Update session store types to include runtime type.
- [x] Keep all runtime execution behavior unchanged.

Checkpoint:
- [x] Backend boots cleanly after migration.
- [x] Existing sessions can resume/prompt normally on the pi path.

### Phase 2: Runtime abstraction with pi compatibility first

Status: 🟡 In progress (core seam complete)

- [x] Create `packages/backend/src/runtimes/registry.ts` with runtime adapter registration + lookup helpers.
- [x] Introduce a `PiRuntimeAdapter` and `PiAgentRuntime` wrapper around current session behavior.
- [x] Transition `ManagedSession` to runtime-based orchestration.
- [x] Move active orchestration paths behind `managed.runtime.*` (prompt/steer/abort, idle eviction, health/task streaming checks).
- [x] Add shared runtime model catalog types (`ProviderInfo`/`ModelInfo`) to registry.

Checkpoint:
- [x] All active code paths still execute through pi behavior, now behind `managed.runtime.*`.
- [x] No user-visible change in pi session behavior.

### Phase 3: Session routing + model catalog through adapters (pi-only traffic)

Status: 🟡 In progress (partial)

- Update `sessions.ts`:
  - [x] `createNewSession()` persists model identity + runtime type (`agent_runtime_type="pi"`).
  - [ ] `createNewSession()` resolves model/runtime through adapter contracts (not hardcoded pi path).
  - [ ] `resumeSession()` routes by persisted `agent_runtime_type`.
  - [ ] enforce runtime immutability for existing sessions.
- [x] Update `ws.ts` command dispatch to only call `managed.runtime.prompt/steer/abort`.
- [x] Update `/api/models` to use runtime-adapter `listModels()` output.
- [ ] Update `PUT /sessions/:id/model` validation so updates are only allowed within the session runtime; return `400` on cross-runtime attempts.

Checkpoint:
- [x] Restart and smoke-test all session APIs/WS commands with pi sessions.
- [ ] Confirm no cross-runtime selection is possible for existing sessions.

### Phase 4: Claude SDK runtime implementation (opt-in path)

Create `packages/backend/src/runtimes/claude_agent_sdk/` with:

- `adapter.ts` — `ClaudeSdkRuntimeAdapter` implementing `AgentRuntimeAdapter`
- `runtime.ts` — `ClaudeSdkAgentRuntime` class wrapping a long-lived SDK `query()` handle:
  - `prompt(text)` → send first user message, then use `streamInput()` for follow-ups while the runtime is warm
  - `steer(text)` → best-effort interrupt and queue/inject follow-up input in-order
  - `abort()` → interrupt active query
  - `subscribe(listener)` → event mapping from SDK to Reins format
  - `getMessages()` → SDK session message fetch + transform
  - `close()` → cleanup
- `tools.ts` — Wire Reins' custom tools into `createSdkMcpServer()` with real handlers
- `events.ts` — Event mapping: `SDKMessage` → Reins broadcast event format

Also in this phase:
- Add route support to fetch messages via `managed.runtime.getMessages()` where applicable.
- Ensure runtime-layer normalization keeps frontend message/event shapes unchanged (including tool call/result blocks).
- Add Claude SDK compaction UI notice when a compact boundary is observed (italic informational message).

Checkpoint:
- Pi sessions remain unaffected.
- Claude runtime only engages for sessions explicitly created with `agent_runtime_type="claude_agent_sdk"`.

### Phase 5: Frontend/runtime UX + polish

- Update frontend model catalog types/usages for `hasKey` → `isAvailable`, `keySource` → `availabilitySource`, and `keySources` → `availabilitySources`.
- Keep a single model picker UI, grouped/labeled by runtime section (e.g., "Claude Code", "Direct").
- Scope session model picker options to the session's runtime so users cannot select cross-runtime models.
- Thinking level mapping for SDK models.
- Error handling for SDK subprocess failures.
- Document current SDK session file behavior (`~/.claude/projects/`) and track follow-up migration to SDK pluggable storage adapter.
- Improve user-facing error messages for invalid model update attempts (including cross-runtime rejection).

## Decisions and tracked considerations

1. **SDK process lifecycle** *(resolved approach)*: Keep one long-lived SDK query handle per active Reins session and send follow-up user messages via `streamInput()` instead of starting a new query per turn. Reins idle eviction should call `managed.runtime.close()` (delegating to SDK query `.close()`) before removing the in-memory session. Resource usage should still be monitored under high concurrency, but this avoids per-turn process churn.

2. **Custom tool naming** *(resolved approach)*: Keep MCP-prefixed tool names at execution time (`mcp__custom-tools__<name>`) as required by the SDK, and map them back to canonical Reins tool names (`create_task`, `delegate`, etc.) for session message storage and API responses.

3. **Steering semantics** *(resolved approach)*: Reins' user-facing contract is "sending a message while streaming" (WS `steer`), which behaves like a queued follow-up input rather than a hard preemption guarantee. Claude SDK runtime should implement compatible behavior (best-effort interrupt + ordered follow-up delivery) without promising pi-specific mid-tool interruption semantics.

4. **Compaction visibility** *(resolved approach)*: Monitor `SDKCompactBoundaryMessage` events to detect when Claude Code compaction occurs. We do not get pi-style compaction summary text from the SDK; in the UI, show an italic informational message (for example: "Claude Code compacted and we don’t have visibility into the summary.").

5. **Session file cleanup** *(resolved for now)*: Leave SDK-managed session files in `~/.claude/projects/` as-is for now. Reins will duplicate session/message data into SQLite for querying and UI needs. Track future migration to the SDK's planned pluggable storage adapter so Reins SQLite can become the primary backing store for SDK sessions.

6. **`process.cwd()` assumption** *(resolved approach)*: Reins disables Claude Code settings file loading (`settingSources: []`) to keep runtime behavior Reins-controlled and session-like. Given this, `cwd`-sensitive Claude settings discovery is not a blocker for this integration (and this is already how Reins runs today).

7. **Frontend message format** *(resolved approach)*: Runtime implementations own message/event normalization into Reins' existing frontend format. Pi runtime can pass through near-native structures; Claude SDK runtime must transform `SDKMessage`/session message shapes (including `tool_use`/`tool_result`) into Reins-compatible `toolCall`/`toolResult`-style events and message payloads at the runtime boundary.

8. **Model/runtime mapping UX** *(resolved approach)*: Keep a single model picker for now, grouped/labeled by runtime sections (e.g., "Claude Code" for `claude_agent_sdk`, "Direct" for `pi`). Do not add a separate runtime selector in this phase. For existing sessions, continue enforcing runtime immutability and only allow/show models from that session's runtime.