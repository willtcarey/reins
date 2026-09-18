# Runtimes

Reins uses one canonical session runtime: AgentHarness backed by Pi providers and Reins SQLite storage.

## Models and authentication

Sessions can use Anthropic, OpenAI, Google, and other providers present in the installed Pi model catalog. Configure the provider's authentication in Settings or through the provider's supported environment configuration. Database-managed credentials take precedence where supported.

Model identity is exact. Reins does not silently replace an unavailable model. Historical sessions whose model has retired remain readable and can be assigned an available model from the session model picker before the runtime is opened.

New sessions require an explicitly configured model, either from the default model setting or a creation override.

## Execution

AgentHarness owns prompting, native read/write/edit/bash and Reins application-tool execution, retries, steering, compaction, operation recovery, and transcript commits. Reins projects runtime events to the chat UI. Bash commands receive the current session, provider, model, and reasoning environment, including after live model changes.

Busy messages use Pi's native steering. Waiting observes native operation settlement and never aborts the target. Reopened unfinished operations remain passive until an explicit recovery request drives one.

## Storage

AgentHarness entries and ancestry are stored directly in Reins SQLite through the canonical Pi storage adapter. Reins does not write transcript snapshots or maintain a provider-specific replay transcript.

Archived chat history remains available through pagination. Runtime context and closed-session outcomes follow the active `main` branch ancestry, which may differ from archived history after branching or compaction.

Attachment references remain in entries; attachment bytes are hydrated only at the provider boundary.

## Claude SDK implementation

The previous Claude Agent SDK implementation remains in the source tree but is not currently registered or advertised. It is outside the active runtime and persistence guarantees until its later cleanup or reintegration. Imported Claude sessions use the canonical Pi runtime after explicit provider normalization and exact model-catalog validation.
