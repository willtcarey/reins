# Runtimes

Every session runs on the Reins **node**, a separate process on the same machine as the server that works in your project checkout. Reins uses one session runtime: AgentHarness backed by Pi providers.

## Models and authentication

Sessions can use Anthropic, OpenAI, Google, and other providers present in the installed Pi model catalog. Configure the provider's authentication in Settings or through the provider's supported environment configuration. Credentials entered in Settings (API keys and OAuth sign-ins) are kept by the server and used by the node automatically; signing in or out always happens in the app, not on the node. Database-managed credentials take precedence where supported.

Model identity is exact. Reins does not silently replace an unavailable model. Historical sessions whose model has retired remain readable and can be assigned an available model from the session model picker.

New sessions require an explicitly configured model, either from the default model setting or a creation override.

## Execution

AgentHarness owns prompting, native read/write/edit/bash and Reins application-tool execution, retries, steering, compaction, operation recovery, and transcript commits. Reins streams its progress to the chat UI. Bash commands receive the current session, provider, model, and reasoning environment, including after live model changes.

Busy messages use Pi's native steering. Waiting observes native operation settlement and never aborts the target. Reopened unfinished operations remain passive until an explicit recovery request (the Resume button) drives one.

Messages you send are saved first and delivered to the node in order. If the node is restarting or not yet connected, they wait and are delivered when it connects. If the server restarts at the moment it is handing a message to the node, it re-sends that message after restarting; a message the node had already received is recognized and appears (and runs) only once.

## Where a session lives

Each session belongs to a node. The session action menu shows it as "Node: <name>" and offers "Move to node…" (see [projects](projects.md)). Sessions from before nodes existed live on the server until you next use them, when they move to their node automatically; reading their history never moves them.

## Storage

The node keeps each of its sessions' conversation state; the server keeps a full, continuously updated copy used for history, search, and moving sessions. You can always read a session's history from the server, even while its node is offline. If a node loses its data, the session's next message restores it from the server's copy (anything the node had not yet sent to the server is lost).

Archived chat history remains available through pagination. Runtime context and closed-session outcomes follow the active `main` branch ancestry, which may differ from archived history after branching or compaction.

Attachment references remain in entries; attachment bytes are hydrated only at the provider boundary.

## Claude SDK implementation

The previous Claude Agent SDK implementation remains in the source tree but is not registered or advertised. It is outside the active runtime and persistence guarantees until it is rebuilt.
