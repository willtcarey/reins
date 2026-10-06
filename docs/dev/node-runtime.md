# Node runtime

Every session runs on a node (see [node-contract.md](node-contract.md)); the server never builds a session runtime. This doc describes the node's session runtime: how it is assembled, what it does with commands, which events it emits in what order, and how run lifecycle reaches the server.

Code: `packages/node/src/runtime/` (`build.ts` assembly, `pi-runtime.ts` the runtime, `types.ts` node-side runtime types; event and message shapes are in `@reins/node-protocol`), driven by `packages/node/src/node.ts`. The only runtime is AgentHarness (Pi 0.85) over the session's storage on the server (`RemoteStorage`). The dormant backend Claude SDK runtime and its trace scripts have been removed; any future runtime belongs on the node.

## Assembly

The node opens a session's runtime lazily, when a prompt, steer, setModel or resumePending arrives, from what that command carries (binding, task branch, lane seed, runtime configuration), and caches it in its runtime map. Opening and closing are serialized per session; a runtime a failed storage call left stale is closed and reopened before the next command (node-contract.md *Link loss*). `buildNodeRuntime` (`runtime/build.ts`):

- Opens the session's storage on the server: a `RemoteStorage` whose every read and commit is a `storage.*` call, with a `prepare` step that uploads inline images before a commit references them.
- Creates Pi's model/resource context (`createPiContext`, `@reins/node/runtime`) with the node's `RemoteCredentialStore` (credentials are served by the server).
- Reads the model from Pi's lane, else (a session that never ran) takes the command's lane seed, and validates it against the node's registry: an unknown model throws `NodeModelNotFoundError`; no model at all fails with "AgentHarness Pi runtime requires an explicit model". Pi creates a missing lane from that model and thinking level when the runtime opens.
- Checks out the command's `branch` (an agent task session's; none for a scratch session or a utility kind) in the binding cwd with node-local git if the current branch differs (a git failure fails the open).
- Builds tools: native read/write/edit/bash sharing one cwd-scoped `NodeExecutionEnv` (`@reins/node/host-tools`; bash gets the live session/provider/model/reasoning environment), then the Reins tools `create_task`, `search` and `execute` (`@reins/node/reins-tools`), which call the server (see node-contract.md *Agent tools*). Every tool is registered; on open the lane's active tools are set to the command's `runtime.tools` (absent: every registered tool), so Pi offers the model only those and long-lived sessions gain new tools and drop removed ones. A name the node does not have rejects the command `invalid_request`.
- Discovers resources with `ReinsResourceLoader` in the bound source cwd (`~/.agents/AGENTS.md`, ancestor AGENTS files, global/project skills); Pi's own context/skill discovery is disabled so prompt listings, executable skills, slash expansion and UI suggestions agree. Pi still loads its prompt templates.
- Builds the system prompt from the command's `runtime` (the session's kind, resolved by the server; node-contract.md *Session kinds*): the server's `systemPrompt`, then, when `environment` is true, the node's environment from `environmentPrompt` (`@reins/node/system-prompt`): the active tools with their snippets, the REINS docs paths of this install (resolved from `import.meta.url`), context files and skills. A utility kind (`environment: false`) gets exactly its prompt. The prompt is fixed when the runtime opens: a runtime already open keeps it until it is reopened. Fixture tests pin both halves (`runtime/system-prompt.test.ts` on the node, `__tests__/sessions/system-prompt.test.ts` on the server). `bun packages/backend/scripts/print-reins-system-prompt.ts --cwd <project> [--task-title … --task-description …]` prints an agent session's whole prompt for the default tool set without creating a session.
- Registers the `after_tool` hook that turns tool-result images into attachment references (uploading new bytes first), and the provider hydration that turns references back into bytes from the node's in-memory attachment cache, fetching a miss from the server.
- Adds `x-session-affinity: <session ID>:main` at the `before_request` boundary for assistant requests to Anthropic Messages models that opt into `sendSessionAffinityHeaders` (such as Meridian). Pi's API-key path adds this header itself, but its OAuth path does not. This keeps client-owned tool rounds on one upstream session, including after a Reins runtime reopen; compaction and other standalone structural requests are not joined.

## Runtime operations

`AgentHarnessPiRuntime` (`runtime/pi-runtime.ts`) wraps one AgentHarness lane (`main`):

- **`prompt(content, {reinsId, metadata})`** expands slash skills/templates with the bound cwd, then durably admits a `reinsInput` message keyed by `reinsId` (the browser's `clientId`) and drives the run in the background; it resolves with the entry ID without waiting for the response. A replay of an admitted `reinsId` returns the existing entry (and drives a recovered operation if not active); a concurrent admission of the same input is joined. If a passively reopened operation is pending, the prompt is queued as steering and resumes it instead of failing with `LaneBusy`.
- **`steer(content, …)`** durably queues the input through Pi's native steering: active work consumes it, an idle lane starts a run from it, a passively reopened operation is resumed. Replays of a queued or admitted `reinsId` do nothing. There is no Reins follow-up queue or abort/restart fallback.
- **`resumePendingOperation()`** drives an operation reopened passively after an interruption, without adding input (`session.resumePending`: the server's automatic resume of a lost run, or `POST /api/sessions/:id/resume`), and returns true. It is replay-safe: true as well when the operation is already being driven (an input joined it first), false when there is nothing to resume. Reopened operations stay passive until resumed, steered or joined by the next prompt.
- **`abort()`** requests abort of the active operation and waits for the lane to go idle; queued steers are discarded. With nothing active it does nothing.
- **`setModel({provider, modelId, thinkingLevel?})`** validates the model against the registry and writes it (and the thinking level, if given) to Pi's lane, effective from the next LLM turn.
- **`getMessages()`** projects the active branch into Reins messages for test inspection; production child replies are projected directly from server storage.
- **`isStreaming()`** is true while an admission, a queued-steering start or an operation is in flight; the node uses it for busy checks. The server reads activity only from lifecycle reports and its outbox.
- **`isPaused()`** is true when cutting the runtime off would lose nothing: no admission or tool call in flight, and every run it drives held at a pause point (see *Pause points*). An idle runtime is paused.
- **`waitForIdle()`** is test support; production observes runs through lifecycle reports and events.
- **`close()`** aborts, closes the harness and cleans up the execution environment.
- **`suspend()`** closes the harness without aborting: the run stays pending in the session's storage, where the next runtime to open the session resumes it. A run held at a pause point loses nothing; a request or tool call still in flight is cut off (its abort signal fires) and recovered by Pi on resume.

Durability: AgentHarness is the only transcript writer. Entries, lane values, lists and usage commit through `RemoteStorage` straight into the server's copy, the only one (see [session-message-persistence.md](session-message-persistence.md)). Runtime events never trigger transcript writes.

### Pause points

A node pausing for a reload or a shutdown (node-contract.md *Pausing runs*, [ADR-021](../adr/021-explicit-node-reload.md)) closes its `PauseGate` (`runtime/pause-gate.ts`), which every runtime it opens shares (`NodeRuntimePolicy.pauseGate`). While it is closed, two hooks wait for it to open or for the run's abort signal: `before_request` for the **assistant** step (the run is `assistant.ready` or `assistant.retry_wait`: its request is not recorded yet) and `before_tool` (the call is still `planned`). Both are clean: Pi resumes a run cut off there into a fresh request, without an interrupted message or a retry attempt, or runs its tool normally. A compaction summary's `before_request` is not one: Pi records that effect before asking. The hooks return when released, never throw: Pi catches a hook's error, and a throwing `before_tool` blocks its tool. An abort releases a held run, which then ends aborted as usual. The runtime counts its held runs and its tool calls in flight (`tool_start`..`tool_end`) for `isPaused`; parallel tool calls each hold separately. Where a run is cut off elsewhere decides what resuming costs: mid-request, Pi records the saved partial output as interrupted and asks again (one retry attempt); mid-tool, it reruns only tools marked `replay: "safe"` (no Reins tool is) and gives the model the last saved output with "outcome unknown". Fixture tests in `runtime/pi-runtime.test.ts` (*pause points*) hold and suspend a run at each point and resume it in a new runtime.

## Events

Each runtime emits normalized `AgentRuntimeEvent`s (`session-events.ts` in `@reins/node-protocol`, shared with the server) to an `emit` sink bound at creation. The node serializes each once and relays it to the server as a `session.event` notification (best effort, per-session `seq`), and the server relays the string unread to browsers as `{type: "event", sessionId, projectId, seq, event}` (node-contract.md *`session.event`*). Native Pi events are mapped explicitly; nothing is passed through unchecked.

| Pi harness event | Runtime event | Notes |
|---|---|---|
| `run_start` | `agent_start` | |
| `turn_start`, `turn_end` | `turn_start`, `turn_end` | `turn_end` carries the message and tool results |
| `message_start/end` | `message_start/end` | The complete message snapshot and a `streamId` stable for that message's lifecycle; `message_end` carries `entryId` when Pi exposes the durable entry. Includes user and tool-result lifecycles: consumers check `message.role` |
| `message_update` | `message_update` | Assistant streaming only: `{streamId, assistantMessageEvent, message?}`. See *Streaming message updates* |
| `entry_added` | `entry_added` | The canonical `ConversationEntry` envelope: `id` (harness entry ID), `parentId`, `seq`, `clientId` (the `reinsId` of a `reinsInput`) and the content-only message. Message and compaction entries only |
| `tool_start/update/end` | `tool_execution_start/update/end` | Stable `toolCallId` and canonical tool name; `tool_execution_end.result` is `{content, details?}` |
| `retry_scheduled`, `retry_end` | `auto_retry_start`, `auto_retry_end` | UI diagnostics |
| `compaction_start/end` | `compaction_start/end` | Not a terminal boundary |
| `run_end` | `agent_end` | `runId`, `status` (`completed`/`failed`/`aborted`), structured `error` when failed, and the run's non-input messages (diagnostics only) |

Images in events are always attachment references; see node-contract.md *Attachments*.

### Streaming message updates

A `message_update` carries Pi's own step as `assistantMessageEvent`, without Pi's `partial` snapshot (`AssistantStreamEvent`): `text_start`/`thinking_start`/`toolcall_start` `{contentIndex}`, `text_delta`/`thinking_delta`/`toolcall_delta` `{contentIndex, delta}`, `text_end`/`thinking_end` `{contentIndex, content}` and `toolcall_end` `{contentIndex, toolCall}`. Every delta is sent: there is no time-window coalescing, so text streams token by token.

The full message is included as `message` only as a **keyframe**: on the stream's first update, on every block start (a new block's identity, such as a tool call's ID and name or redacted thinking, is only in Pi's snapshot), and otherwise when `MESSAGE_KEYFRAME_INTERVAL_MS` (1 s; injectable with the clock as `messageKeyframes`) has passed since the stream's last keyframe. A keyframe is the message after its step. Its content is built on the node from the steps sent so far (`applyStreamStep` in `pi-runtime.ts`), not copied from Pi's `partial`: that is the provider's live message and can already hold steps the harness has not delivered, which a client applying later deltas would double. A tool call still streaming carries its raw argument JSON so far as `partialJson` (providers name or omit that field differently); its parsed `arguments` stay as they were at the block start until `toolcall_end` carries the complete call.

Applying a step (Pi's semantics, the same on node and browser): a block is as its start keyframe shows it, `text_delta`/`thinking_delta` append to `text`/`thinking`, `toolcall_delta` appends to `partialJson`, and `*_end` is authoritative (`text_end`/`thinking_end` replace the text; `toolcall_end` replaces the block). Signatures reach the browser with the next keyframe or `message_end`.

### Ordering

A simple completed run (each committed message is also announced by an `entry_added`):

```text
agent_start
→ turn_start
→ message_start/update…/end
→ tool_execution_start/update…/end   (per tool call)
→ turn_end
→ … further turns …
→ agent_end(status=completed)
```

With automatic compaction:

```text
agent_start → … turns … → compaction_start → compaction_end → agent_end(status=completed)
```

AgentHarness emits `run_end` from the durable terminal commit, after everything the operation owns: provider retries, deferred polling, accepted steering and automatic compaction. So compaction, retries and steering appear **inside** the run, before the single `agent_end`; `compaction_start` may precede the first turn. Failed and aborted runs end with `status=failed`/`aborted` and preserve the native error. There is no later synthetic settlement. During the `run_end` callback `isStreaming()` may still be true (local cleanup follows event delivery); nothing derives the lifecycle boundary from it.

The node emits a session's events in occurrence order. Transcript commits reach the server before the run's settlement report (see *Lifecycle reports*), but live events and reports travel separately: a browser can see `agent_end` before or after the settled session update.

### How the frontend consumes events

- `entry_added` is the only way a durable chat entry appears live; message pages return the same envelope. The frontend upserts by `id` and resolves an optimistic input only when an entry carries its `clientId`: no FIFO, content or timestamp matching.
- Streaming messages (`message_*` by `streamId`) are presentation overlays built from snapshots and deltas (see *Streaming message updates*); a sequence gap makes an overlay wait for the next keyframe (frontend-architecture.md, `ConversationsStore`). `message_end.entryId` lets the overlay be removed when its entry arrives. `agent_end` clears remaining overlays and surfaces the terminal error; it never inserts transcript entries.
- `compaction_start`/`compaction_end` drive the compacting indicator; `auto_retry_*` show retry status.

**Context occupancy** is not an event: the session context REST resource reads the active `main` branch and uses the usage in the latest valid assistant message with AgentHarness's `estimateContextTokens` semantics (so standalone structural calls such as compaction summaries never count). `entry_added` and `compaction_end` schedule a refresh; `compaction_start` marks the previous measurement unknown; after compaction the replacement context is estimated until the next assistant response.

## Lifecycle reports

The runtime takes a `RuntimeLifecycleSink` at construction and calls `started(runId)` for native `run_start`, `run_resume` and `compaction_start`, and `settled(runtime, outcome)` for `run_end`. The node (`lifecycleReports` in `build.ts`) turns these into `session.started` and `session.settled` reports sent over the newest connection, in order, each once (a report made with no connection waits for one; node-contract.md *Link loss*), with the lane's model/thinking metadata and Pi's committed `run_end.tipId`. The server projects child replies from that exact ancestry; the node does not read the transcript to send it back. Reports follow the commits they summarize; one that cannot be delivered is lost, and the server resumes its run (or settles it as interrupted) when the node reconnects (node-contract.md *Lifecycle reports*, *Crash recovery*):

- `started`: the session's activity becomes `running`.
- `settled`: model/thinking metadata is persisted; a top-level session becomes `finished` (unread); a child's result is queued to its parent as a steer (clean result or error text with `metadata.sourceSessionId`) in the same transaction, and the child clears to idle. If the reply could not be read or the parent cannot receive it, the child becomes `finished` with no report.

Opening a runtime emits no settlement and produces no report. Pi may resume a run the server already settled as interrupted under the same run ID; its reports apply again (node-contract.md *Lifecycle reports*).

## Messages

`RuntimeMessage` is Reins-normalized:

- `reinsInput` (canonical storage only) carries block content, a stable `reinsId` and application `metadata`. Projections show it as `role: "user"` (with `metadata` when present). Provider projection strips both fields and, when `metadata.sourceSessionId` is set, frames the content as a Reins session update that is not new user authorization.
- User content is blocks: `{type: "text"}` and image attachment references; bytes are hydrated only at the provider boundary.
- Assistant content: `text`, `thinking` (with optional `thinkingSignature`) and `toolCall` blocks; `stopReason`; a `timestamp` stable across the message's lifecycle.
- Tool results: `toolCallId`, `toolName`, `content`, `isError`, `timestamp`.
- Compaction: `role: "compactionSummary"` with `summary` (no `content`).

Metadata is supplied at admission and never reconstructed from timestamps, IDs, content or position.

## Session orchestration

Scripts reach sessions through `api.sessions` (see [scripting](../features/scripting.md)); `sessions/session-instance.ts` on the server implements it over the outbox and projections (`sessions/session-runs.ts` for waits), never a live runtime:

- `start(prompt, options)` creates a session (child or independent, depth limit three) on its node and queues its prompt; it returns `{sessionId}` without waiting.
- `send(sessionId, message)` queues a steer with `metadata.sourceSessionId` for any session in the caller's project; the node's native steering decides how it joins or starts work.
- `wait(sessionId, timeoutMs?)` observes settlement through server projections (node-contract.md *Server reads projections only*), bounded to 0–30 000 ms; cancelling it never aborts the target.

Sessions share their source checkout; no lock is held across execution, and parent links do not propagate cancellation.

## Adding or replacing a runtime

A future runtime (the Claude rebuild, an ACP adapter; see [ADR-006](../adr/006-acpx-as-runtime-replacement.md)) plugs in on the node and must keep the contracts above: durable admission keyed by `reinsId` (replays must converge, see node-contract.md *Replay idempotency*), native steering, the normalized event table with stable `streamId`/`toolCallId`, `entry_added` envelopes, one terminal `agent_end` and one `settled` per run, lifecycle reports ordered after the commits they summarize, attachment references instead of image bytes, and the Reins tool set. For conversation trees it must also continue from an arbitrary persisted prefix (native fork or exact prefix hydration); pasting a transcript into a new prompt is not equivalent. AgentHarness already stores tree-shaped ancestry and selects context through a lane branch tip.
