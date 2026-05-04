# ADR-006: acpx as a Universal Runtime Replacement

- **Status:** Rejected
- **Date:** 2026-05-04
- **Author:** Will (with Reins)

## Context

We evaluated whether [`acpx`](https://github.com/openclaw/acpx) should replace Reins's runtime-specific adapters. acpx is a headless client/runtime for the Agent Client Protocol (ACP). It can launch ACP-compatible coding agents such as Claude Code, Codex, OpenClaw, and potentially Pi through ACP adapters.

The proposal was attractive because acpx already owns several runtime concerns:

- ACP adapter process launch and JSON-RPC/NDJSON transport.
- `session/new`, `session/load`, `session/prompt`, `session/cancel`.
- Client `fs/*` and `terminal/*` handlers.
- ACP auth handshake.
- Built-in agent command presets.
- An embedded `acpx/runtime` API, avoiding CLI shell-out.

If acpx could fully replace our runtime adapters, Reins might avoid maintaining separate Pi and Claude Code runtime integrations.

## Decision

**Reject acpx as the universal replacement for Reins runtime adapters.**

Reins will keep its own `AgentRuntime` abstraction as the architectural boundary. acpx may still be useful as an opt-in runtime adapter or as implementation plumbing for ACP-compatible agents, but it should not become the canonical Reins runtime contract and should not replace all existing runtime adapters wholesale.

## Reasons

### 1. Conversation forking requires more than ACP `session/load`

Reins wants first-class conversation forking: continue from a prefix of a conversation, then branch down a different path.

acpx's current `session/load` path is resume-by-id. It calls ACP `session/load` with an existing adapter-owned session id, cwd, and MCP servers. It does not pass a message array and does not create a new session from an arbitrary transcript prefix.

acpx also documents ACP `session/fork` as unsupported/unstable in its current coverage roadmap.

For true Reins forking, a runtime must support one of:

1. **Native fork** — fork the runtime/agent's internal conversation state.
2. **Prefix hydration** — create a fresh runtime session from a supplied list of Reins-normalized messages.

Prompting a fresh session with a transcript/summary is only an approximation; it does not structurally restore tool calls/results or provider-specific state.

Pi is closest to the desired behavior today because its session manager is tree-shaped. Claude Code direct SDK integration may be able to support prefix hydration through our SDK `sessionStore` bridge. Claude Code through acpx/ACP should not be assumed to support true forks until ACP `session/fork` exists end-to-end or the adapter exposes transcript import/hydration.

### 2. Reins still needs its own event and message contract

acpx runtime events do not match Reins's frontend/persistence event contract directly. Reins needs normalized events such as:

- `agent_start`
- `message_update` with `text_delta`
- `tool_execution_start/update/end`
- `turn_end`
- `agent_end`
- `compaction_start/end`

Reins also needs `getMessages()` to return Reins-normalized `AgentRuntimeMessage[]` for SQLite persistence and resume. acpx's local session projection is not the same contract.

Replacing Reins's runtime boundary with acpx would leak ACP/acpx-specific shapes into the rest of the app.

### 3. Reins custom tools still need adapter-specific exposure

Reins custom tools (`create_task`, `delegate`, `search`, `execute`) are part of the runtime contract. acpx/ACP agents primarily receive ACP client filesystem/terminal capabilities and configured MCP servers.

A Reins acpx adapter would still need to expose custom tools to ACP agents, likely through a reusable MCP bridge. acpx does not remove that responsibility.

### 4. Model and agent selection are not the same abstraction

Reins stores runtime identity separately from provider/model identity:

- Runtime: `agent_runtime_type`
- Model: `model_provider`, `model_id`, `thinking_level`

acpx primarily selects an ACP agent command and optional adapter-specific session options. That does not map cleanly onto Reins's model picker/catalog semantics without an adapter layer.

### 5. Runtime ownership and persistence overlap

Reins owns session lifecycle, SQLite persistence, frontend streaming, task/project context, and runtime resume. acpx also has its own CLI/session persistence model under `~/.acpx` and queue-owner behavior.

Using acpx as a library may still be viable, but Reins should not hand over canonical persistence or session semantics to acpx.

### 6. Operational maturity and embedding risk

acpx is alpha and documents that its CLI/runtime interfaces may change. It also has Node-oriented adapter launch assumptions that need validation under Reins's Bun backend.

These are acceptable for an opt-in adapter spike, but not for replacing all existing runtimes.

## Consequences

- Keep the Reins `AgentRuntime` and `AgentRuntimeAdapter` contracts.
- Do not replace the Pi and Claude Code SDK runtimes with acpx wholesale.
- Continue to treat Pi as the reference runtime for native conversation-tree/fork behavior.
- Investigate Claude Code direct SDK prefix hydration separately from acpx.
- acpx remains eligible for a future opt-in runtime adapter for ACP-compatible agents, provided that adapter translates events, messages, tools, model selection, and persistence into Reins contracts.
- Future conversation-tree work should define a Reins-level optional runtime capability for native fork or prefix hydration.

## Related documents

- [`docs/dev/runtime-adapter-contract.md`](../dev/runtime-adapter-contract.md)
- [`docs/plans/acpx-research.md`](../plans/acpx-research.md)
- [`docs/plans/conversation-tree.md`](../plans/conversation-tree.md)
