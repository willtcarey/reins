# Stored message metadata persistence

Status: **completed through canonical AgentHarness storage**

Application metadata is stored when a Reins prompt is durably accepted as the supported AgentHarness `reinsInput` custom message. Each input carries its stable `reinsId` and metadata in the canonical entry envelope; provider projection converts it to an ordinary user message and strips Reins-only identity and metadata.

This supersedes the earlier snapshot-based design. There is no post-hoc `attachStoredMessageMetadata()`, runtime snapshot reconciliation, guessed identity matching, side table, or legacy Pi hydration path. The exact AgentHarness entry ID is projected as `logicalId` where application readers need stable identity.

Transactional review submission uses `acceptPrompt(..., { reinsId, metadata, onCommit })`, allowing the review mutation and exact prompt entry to commit atomically before provider execution. Legacy imported inputs begin with empty metadata because the approved source history contains no application metadata.

Implementation and validation details are recorded in [AgentHarness storage migration](completed/agent-harness-storage.md).
