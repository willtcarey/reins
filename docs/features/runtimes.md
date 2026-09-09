# Runtimes

A runtime is the execution engine behind an agent session. It controls how the agent loop runs — how turns are processed, how tools are executed, and how conversation history is managed. Reins supports multiple runtimes, each with different trade-offs.

When you pick a model, you're also choosing a runtime. The model picker groups models by runtime so you can see which engine will power the session. Once a session has messages, its runtime is locked — you can still switch models within the same runtime, but you can't change runtimes on an active session.

## Available runtimes

### Direct (pi)

The Direct runtime uses [pi](https://github.com/nickarino/pi-coding-agent) as its agent loop. Reins manages the full turn cycle: LLM API call, tool execution, feeding results back, and repeating until the agent is done.

**Models**: Anthropic (Claude), OpenAI, Google (Gemini), and other providers supported by pi. Each provider requires its own API key, configured via environment variable or the settings panel.

**Authentication**: Requires an API key per provider. You can set these as environment variables (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or configure them in the Reins settings panel. Database-managed keys take precedence over environment variables.

**Tool execution**: Reins executes all tools directly — both coding tools (read, write, edit, bash) and app tools (create_task, search, execute). Tool calls and results are visible in chat with full detail.

**Steering**: Supported through Pi's native steering point. Queue delivery also uses Pi's native follow-up queue. During standalone compaction, sends await Pi's native idle signal before delivering; they do not interrupt compaction. Waiting uses Pi's native idle state, which may still report idle during startup; Reins does not add promise tracking or startup guards to mask that limitation.

**Context management**: Reins manages compaction automatically. When the conversation grows too long, it compacts the history and shows a summary of what was condensed.

**Session storage**: Conversation history is stored in Reins' SQLite database.

### Claude Code (claude_agent_sdk)

The Claude Code runtime uses the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) to run an embedded Claude Code agent. The SDK owns the full agent loop — tool execution, turn management, and session persistence all happen inside the SDK subprocess.

**Models**: Anthropic Claude models only. The full Claude model lineup is available, from Haiku through Opus.

**Authentication**: Uses the Claude Code authentication already present on the machine where Reins is running. Authenticate by either:
- Running `npx @anthropic-ai/claude-code` and signing in (Claude Code login)
- Setting `ANTHROPIC_API_KEY` in the Reins process environment

No API key configuration is needed in the Reins settings panel — the runtime shows a `local` auth badge to indicate it relies on host-level auth. If Reins runs on a different machine from your browser, the auth must exist on the Reins host.

**Tool execution**: The SDK executes its own built-in tools (Read, Write, Edit, Bash, Grep, Glob) natively. Reins app tools (create_task, search, execute) are registered as an MCP server that the SDK calls into. Tool names are normalized in the UI — you see `read`, `edit`, etc. regardless of runtime.

**Steering**: Not currently supported. A scripted `steer` request to a busy session reports an error; it does not cancel/restart or silently queue the message. Busy `queue` requests are also unsupported. Wait for the session to settle, then send another message; idle sends start work normally.

**Context management**: The SDK manages compaction internally. When compaction occurs, Reins shows an informational notice in chat. Unlike the Direct runtime, the compaction summary is not visible — the SDK handles it opaquely.

**Session storage**: Reins supplies a database-backed SDK session store. SQLite is the canonical transcript and resume source; runtime-private files are not required to reopen a session.

Both runtimes support [asynchronous session orchestration](scripting.md#start-message-and-wait-for-sessions) through `api.sessions`. Pi supports native queue delivery; Claude accepts sends only when idle. Session waiting includes all accepted work and native settlement. Aborting a session discards pending queued work. Cancelling only a waiter leaves work running.

## Choosing a runtime

Both runtimes use the same system prompt, the same project/task context, and the same set of tools. The main differences:

| | Direct (pi) | Claude Code (SDK) |
|---|---|---|
| Providers | Anthropic, OpenAI, Google, others | Anthropic only |
| Auth | API key per provider | Claude Code login or ANTHROPIC_API_KEY |
| Steering mid-turn | Yes | No (explicit error) |
| Compaction visibility | Summary shown | Notice only |
| Tool execution | Reins-managed | SDK-managed (built-ins) + MCP (app tools) |

Pick **Direct** when you want multi-provider model access or mid-turn steering. Pick **Claude Code** when you want to use Claude Code's native agent loop and authentication.

## Runtime immutability

A session's runtime is fixed once it has messages. This prevents confusing state where conversation history was created by one engine but is being continued by another.

- **New sessions** (no messages yet): You can freely switch between any model in any runtime.
- **Active sessions** (has messages): The model picker only shows models from the session's current runtime.

If you want to try a different runtime, start a new session.
