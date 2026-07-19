# Optimistic skill-message reconciliation

Status: **implemented**

## Goal

Prevent skill-expanded runtime user prompts from appearing as duplicate visible messages while preserving expanded instructions in persisted runtime history.

## Final approach

- Keep the existing message schema and wire command shapes. No client-generated ID protocol, submission tracker, auxiliary table, or persisted display metadata is introduced.
- Keep skill expansion and persistence unchanged. Backend display APIs continue stripping injected leading `<skill>` blocks.
- Treat runtime `agent_end` user messages as persistence inputs only. The frontend ignores every `role: "user"` message in `agent_end`, while retaining assistant and tool-result messages.
- `ConversationsStore` owns optimistic and peer-live user entries. Once a forward persisted snapshot has been established, genuinely new persisted forward user rows consume pending live users FIFO without comparing content.
- Initial snapshots, stale or overlapping pages, and earlier-history pages do not consume pending entries. Repeated identical prompts remain distinct and reconcile one-for-one.
- Prompt and steer commands broadcast their raw, unexpanded user content to peer clients.
- Running activity broadcasts remain immediate. Terminal checkpoint persistence and metadata updates finish before the `finished` activity transition broadcasts `session_updated`, so completion-triggered refreshes see the durable final transcript.

## Compatibility and trade-offs

Raw runtime events remain compatible and expanded content remains available for exact runtime resume. FIFO reconciliation assumes persisted forward user records correspond to pending live user submissions in transcript order; this matches runtime persistence ordering without making mutable content into identity. A pending entry deliberately remains visible if only an initial, stale, overlapping, or historical page contains a user row, until a genuinely advancing persisted refresh arrives.

## Validation coverage

Tests cover runtime user filtering with assistant/tool preservation, differently shaped persisted user content, repeated local/remote prompts, stale and initial snapshots, peer steer broadcasts, and terminal persistence ordering. Existing Pi, Claude SDK, internal-session, pagination, skill stripping, and runtime persistence suites provide integration coverage for the unchanged persistence paths.
