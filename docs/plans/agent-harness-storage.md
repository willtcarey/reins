# AgentHarness storage migration

Status: **active — storage complete; unselected runtime integration in progress; migration and activation not started**

## Direction

1. Add the public Pi `Storage` adapter against Reins SQLite. **Implemented in `runtimes/pi/storage-adapter.ts`.**
2. Implement the next-generation AgentHarness runtime without selecting or registering it. **In progress in `runtimes/pi/agent-harness-runtime.ts`; current scaffold is intentionally unselected and is not yet a completed integration.**
3. At a later unified cutover, migrate every existing Pi and Claude history into the harness representation and switch the active writers/readers together. **Not started or authorized.**
4. Remove superseded snapshot persistence only after migration validation. **Not started.**

## Step 1 boundaries

`session_messages` is the only harness entry store. Its integer `id` remains Reins identity; `harness_id` is the exact AgentHarness entry ID and `parent_id` references the actual parent row. Existing `seq` is the AgentHarness global write sequence for entry rows, including intentional gaps for non-entry writes. `message_json` contains the typed entry envelope, including exact commit timestamp, entry type, optional custom type, and the complete message, compaction, branch-summary, or custom payload.

Only contract-required non-entry state is separate in `pi_values`, `pi_lists`, and `pi_usage`: scalar values, list elements, and usage ledger rows. `sessions.harness_next_seq` durably allocates sequences even when deletes leave no row. Mixed commits use one SQLite transaction.

`PiStorageAdapter` is canonical-only storage and assumes every row in an attached session has already been migrated: every entry has a `harness_id`, parent links are real, and `harness_next_seq` is initialized beyond every imported write sequence. It has no legacy classification, fallback, storage-format marker, or dual-mode persistence. Because it remains disconnected, those prerequisites are established only by the future all-session migration before activation.

Reins continues to own session creation, open coalescing, parent relationships, deletion, and lifecycle. At cutover it can construct the supported public session directly with `new StorageBackedSession(metadata, new PiStorageAdapter(db, sessionId))`; closing the harness closes that session and adapter. This step does not add a parallel `SessionRepo` or session factory. The adapter reuses public commit validation/preparation and list option resolution from `@earendil-works/pi-agent-core`.

## Unselected runtime boundaries

The runtime constructs public `StorageBackedSession` directly, attaches `AgentHarness`, acquires its `main` lane, and adapts public lane operations and events to Reins' existing runtime contract. A declaration-merged custom input message carries exact Reins identity and metadata; provider projection strips those fields. Construction returns open operations without executing them; callers resume one explicitly through `resumeOpenOperation()`.

The implementation does not register a runtime type or change session creation. Existing production runtimes therefore remain selected and operational. Existing snapshot persistence and entry-envelope-incompatible display/search readers cannot encounter this format through production runtime creation.

Focused real-SQLite/fake-provider coverage proves the exported constructor on fresh canonical SQLite; clean custom-input provider projection; exact stored identity/metadata; normalized streaming lifecycle; run-local terminal payloads; close/reopen without replay; restored lane model/thinking metadata; unknown-model rejection; busy steering consumption; concurrent admission rejection; abort queue clearing and wait settlement; deferred suspend-drive completion; automatic compaction before settlement; coding-tool progress/cancellation propagation with replay-never mutation policy; and attachment hydration only at the provider boundary.

Additional coverage proves retry-specific completion without duplicate submission, truthful non-streaming state at settlement, idempotent harness cleanup after abort cleanup failure, conservative replay-never behavior for unknown/custom wrapped tools, and coding-agent skill/system-prompt projection. `DefaultResourceLoader` performs discovery; the projector reads each skill file once per projection call, and the builder formats context files and the skill listing into the supplied Reins prompt.

Additional coverage proves construction does not execute returned open operations, explicit resumption of one returned operation, and cancellation of a blocked wrapped coding tool through the Chord abort signal. Tool adaptation preserves explicit supported replay policy and argument preparation while defaulting omitted replay policy to `never`.

Operation tracking rejects driving the same operation twice, filters returned open operations to `main`, tracks pending submissions before their first await, rechecks submission/execution state while waiting, and emits settlement only after a confirmed terminal drive result. Focused tests cover duplicate resumption racing an active drive and prompt submission, with exactly one settlement.

The approved narrow seam now returns public four-argument `AgentTool` values from Reins custom tools. The selected Pi boundary alone applies coding-agent `defineTool`, while Claude invokes neutral tools directly. The unselected builder assembles SQLite-backed ModelRuntime authentication, the Reins system prompt, AGENTS/context files, projected coding-agent skills/templates, filtered `createCodingTools` builtins, custom tools, and active tool names. Context files and the model-visible skill listing are included exactly once. Fake-provider assembly coverage exercises both a builtin and custom tool and observes the DB credential at the provider auth resolver.

The bash spawn hook reads mutable runtime configuration rather than captured initial settings. Tests verify `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` before and after `setModel()` changes. `PI_SESSION_FILE` is intentionally absent because this SQLite-backed harness has no session file.

The bounded correctness suite covers an in-process `effect_pending` interruption surrogate: a replay-never tool performs its side effect and remains intentionally blocked before result staging while a second runtime attaches to the same stored operation. Explicit resumption records the interrupted result without invoking the replacement tool or duplicating the side effect. This is not subprocess crash or fencing proof. Separate cases prove wait/close behavior while `lane.accept` is gated before execution tracking, and prove an injected nonterminal `lane.drive` rejection emits no ordinary settlement or stale assistant outcome.

Still incomplete outside these bounded acceptance items: a subprocess/SIGKILL variant of the now-covered effect-pending recovery; injected lane/model/watch constructor failures; watch resnapshot failure behavior; and richer additive failed/aborted terminal diagnostics beyond the existing prompt rejection and durable transcript outcome. The runtime remains unregistered and unselected.

## Deferred

No registration, manager wiring, migration, legacy import, reader cutover, persistence-observer bypass, UI/API change, Claude disablement, or production-data operation has been performed. The future cutover must migrate all existing sessions and update Reins entry-envelope projections before changing runtime writers and readers.
