# Claude Agent SDK Integration Plan

## Goal

Integrate the Claude Agent SDK as a parallel agent loop provider in Reins, alongside the existing pi-backed sessions. The SDK handles auth, API transport, tool execution, session persistence, and turn management. Reins provides the UI, custom tools, system prompt, and session metadata.

## Background

Currently Reins uses pi's agent loop exclusively:
- `streamSimple` makes one LLM API call per turn
- Pi's `agentLoop` manages the turn cycle: LLM call → tool execution → feed results → repeat
- Pi handles tool execution, message persistence, compaction, steering

The existing `claude-agent-sdk` v1 extension (at `packages/backend/src/pi/vendor/claude-agent-sdk-pi.ts`) uses the SDK purely as an inference backend within pi's turn loop. It serializes the full conversation as text into a single prompt, denies all SDK tool execution, and maps stream events back to pi's format. This has limitations:
- Tool results are text-serialized (no structured `tool_result` messages)
- Each turn spawns a new `query()` — no session continuity in the SDK
- MCP workarounds for custom tool schemas

The new approach lets the SDK own the full agent loop while Reins wraps it.

## Architecture

### Provider-based routing

When a user selects a model, the provider determines the execution backend:

```
provider: "anthropic"          → pi AgentSession (direct API, existing path)
provider: "claude-agent-sdk"   → SdkSession (SDK manages loop + tools)
```

The frontend doesn't change — both providers appear in the model picker. Session creation branches based on the provider.

### What each layer owns

| Concern | Pi sessions | SDK sessions |
|---|---|---|
| Agent loop | Pi's `agentLoop` | SDK's `query()` |
| Tool execution | Pi's `AgentTool.execute()` | SDK built-ins (Read/Write/Edit/Bash/Grep/Glob) + MCP for custom tools |
| Session persistence | Reins SQLite (messages) | SDK JSONL files (`~/.claude/projects/`) |
| Session metadata | Reins SQLite | Reins SQLite (project/task links, model config) |
| Session resume | `hydrateSessionManager` + `replaceMessages` | SDK's `resume: sessionId` option |
| System prompt | Pi's `buildReinsSystemPrompt()` | Same prompt, passed via SDK's `systemPrompt` option |
| Events → frontend | `AgentSessionEvent` via `agentSession.subscribe()` | `SDKMessage` mapped to compatible broadcast format |
| Compaction | Pi's `SessionManager` | SDK handles internally |
| Message display | Load from SQLite | `getSessionMessages(sessionId)` from SDK |

### Session interface

`ManagedSession` becomes polymorphic. Both pi and SDK sessions implement a common interface:

```typescript
interface ManagedSession {
  id: string;
  lastActivity: number;
  kind: "pi" | "sdk";

  // Pi sessions: AgentSession instance
  // SDK sessions: SdkSession wrapper
  session: AgentSession | SdkSession;
}
```

The WebSocket handler (`ws.ts`) dispatches commands through a unified interface:
- `prompt(text)` → pi: `agentSession.prompt()` / SDK: send message to `query()`
- `steer(text)` → pi: `agentSession.steer()` / SDK: `query.interrupt()` + new message
- `abort()` → pi: `agentSession.abort()` / SDK: `query.interrupt()` or `query.close()`

### Tool registration

**Built-in tools** (Read, Write, Edit, Bash, Grep, Glob): SDK executes these natively via Claude Code's CLI. No pi involvement.

**Custom tools** (create_task, delegate, search, execute): Registered via `createSdkMcpServer()` with handlers that call the actual tool executors. The model sees these as `mcp__custom-tools__<name>` (e.g., `mcp__custom-tools__create_task`). The system prompt references these prefixed names.

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
2. Create SQLite row with metadata (project, task, model, thinking level)
3. Start SDK `query()` with `sessionId: uuid`
4. Start streaming events → broadcast to WebSocket clients
5. On `result` or abort → update SQLite metadata

**Resume:**
1. Look up session in SQLite → get session UUID and project
2. Start SDK `query()` with `resume: sessionId`
3. Resume streaming events
4. For message history display: `getSessionMessages(sessionId)` from SDK

**Display messages:**
- SDK sessions: call `getSessionMessages(sessionId)` → transform to Reins' message format
- Pi sessions: load from SQLite (existing path)

## Implementation phases

### Phase 1: SdkSession wrapper

Create `packages/backend/src/sdk/` with:

- `sdk-session.ts` — `SdkSession` class wrapping SDK `query()`:
  - `prompt(text)` → send user message
  - `abort()` → interrupt query
  - `subscribe(listener)` → event mapping from SDK to Reins format
  - `close()` → cleanup

- `sdk-tools.ts` — Wire Reins' custom tools into `createSdkMcpServer()` with real handlers

- `sdk-events.ts` — Event mapping: `SDKMessage` → Reins broadcast event format

### Phase 2: Session routing

- Update `ManagedSession` in `state.ts` to support both `kind: "pi"` and `kind: "sdk"`
- Update `sessions.ts`:
  - `createNewSession()` branches based on provider
  - `resumeSession()` branches based on session kind
  - New `createSdkSession()` / `resumeSdkSession()` functions
- Update `ws.ts`:
  - Command dispatch works with either session type
  - Unified interface for prompt/steer/abort

### Phase 3: Message display

- Add route or extend existing route to fetch SDK session messages via `getSessionMessages()`
- Transform SDK `SessionMessage` format to Reins' frontend message format
- Frontend may need minor updates to handle SDK-specific message shapes (tool_use/tool_result blocks vs pi's toolCall/toolResult)

### Phase 4: Polish

- Thinking level mapping for SDK models
- Error handling for SDK subprocess failures
- Session cleanup (SDK session files)
- Model switching mid-session (if supported)

## Risks and open questions

1. **SDK subprocess per session**: Each `query()` spawns a Claude Code CLI process. Resource usage with many concurrent sessions needs monitoring.

2. **Custom tool naming**: Tools appear as `mcp__custom-tools__<name>`. The system prompt must reference these prefixed names. This affects the model's tool selection behavior.

3. **Steering semantics**: Pi has sophisticated steering (interrupt mid-tool, queue follow-ups). SDK's `interrupt()` is simpler — need to verify it handles mid-execution interrupts cleanly.

4. **Compaction visibility**: SDK handles compaction internally. Reins won't know when/if compaction happens unless we monitor for `SDKCompactBoundaryMessage` events.

5. **Session file cleanup**: SDK persists sessions to `~/.claude/projects/`. Need a strategy for cleaning up old session files when sessions are deleted in Reins.

6. **`process.cwd()` assumption**: The SDK extension uses `process.cwd()` for project-local resource paths. Need to verify the `cwd` option properly overrides this for all code paths.

7. **Frontend message format**: SDK stores messages as Anthropic API format (`tool_use`/`tool_result`). Pi stores them in its own format (`toolCall`/`toolResult`). The frontend may need to handle both, or we transform at the API boundary.
