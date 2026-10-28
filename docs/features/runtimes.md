# Runtimes

Every session runs on the Reins server, with the server's models and credentials; its tools (reading, writing and editing files, running commands) run on the Reins **node** of your project's source (its working copy), a separate process on the server's machine or a paired remote machine. Reins uses one session runtime: AgentHarness backed by Pi providers.

## Models and authentication

Sessions can use Anthropic, OpenAI, Google, and other providers present in the installed Pi model catalog. Configure the provider's authentication in Settings or through the provider's supported environment configuration. Credentials entered in Settings (API keys and OAuth sign-ins) are kept and used by the server; nodes need none. Signing in or out always happens in the app. Database-managed credentials take precedence where supported.

Model identity is exact. Reins does not silently replace an unavailable model. Historical sessions whose model has retired remain readable and can be assigned an available model from the session model picker.

New sessions require an explicitly configured model, either from the default model setting or a creation override.

## Execution

AgentHarness owns prompting, native read/write/edit/bash and Reins application-tool execution, retries, steering, compaction, operation recovery, and transcript commits. Reins streams its progress to the chat UI. Bash commands receive the current session, provider, model, and reasoning environment, including after live model changes.

Busy messages use Pi's native steering. Waiting observes native operation settlement and never aborts the target. Reopened unfinished operations remain passive until an explicit recovery request (the Resume button) drives one.

Messages you send are accepted in the order you send them, and so are model changes and `/compact` made between them: the app shows a message as sent once the session has saved it, and a message it could not take (for example, a model the server no longer has) comes back as an error on that message. If the connection drops before the answer, or the server is reloading, the app sends it again until it is answered, and it appears (and runs) only once. If the node is restarting or not yet connected, the message is still accepted; the run waits for the node before it starts working in the checkout.

## Where a session lives

Each session belongs to a node. The session action menu shows it as "Node: <name>" and offers "Move to node…" (see [projects](projects.md)). Every session's durable state and its agent live on the server; its tools run on the selected node. Reading history never starts a runtime or moves a session.

## Storage

The server holds the only durable conversation state. Nodes keep nothing durable. History stays readable while a node is offline. Stopping the server pauses its runs at their next model request or tool call; when it starts again it continues every run it stopped or that a crash cut off, on its own. A run that keeps being cut off (more than three times in ten minutes), or that cannot be resumed, ends as interrupted and stays that way until you resume it or send another message. Reloading the server in development does not interrupt runs. Restarting or reloading a node (`bun run node:reload`, or `api.nodes.reload()` from a script) pauses nothing: a tool call waits for the node to come back, and a command the node lost while it ran is reported to the agent as having an unknown outcome.

Archived chat history remains available through pagination. Runtime context and closed-session outcomes follow the active `main` branch ancestry, which may differ from archived history after branching or compaction.

Attachment references remain in entries; attachment bytes are hydrated only at the provider boundary.

## Other runtimes

The old backend Claude Agent SDK implementation has been removed. Any future runtime integration must satisfy the same persistence and recovery guarantees.
