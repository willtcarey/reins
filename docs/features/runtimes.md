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

Each session belongs to a node. The session action menu shows it as "Node: <name>" and offers "Move to node…" (see [projects](projects.md)). Every session's durable state lives on the server; its agent runs on the selected node. Reading history never starts a runtime or moves a session.

## Storage

The server holds the only durable conversation state. The node reads and commits it over its connection and keeps only in-memory runtimes and caches. History stays readable while a node is offline. After a node restarts, Reins opens the session from server storage; an interrupted operation remains passive until you resume it or send another message.

Archived chat history remains available through pagination. Runtime context and closed-session outcomes follow the active `main` branch ancestry, which may differ from archived history after branching or compaction.

Attachment references remain in entries; attachment bytes are hydrated only at the provider boundary.

## Other runtimes

The old backend Claude Agent SDK implementation has been removed. Any future runtime integration must run on the node and satisfy the same persistence and recovery guarantees.
