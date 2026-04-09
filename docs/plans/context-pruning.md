# Context pruning for cached prompts

## Problem

Long-running sessions accumulate large tool results. Those full results are useful for persistence and UI, but expensive to keep resending to the model on every turn.

Anthropic prompt caching makes this tradeoff sharper: while the cache is warm, keeping old prompt content can still be cheap. Once the cache TTL expires, old tool results become expensive again and consume context window with less value.

## Direction

Keep a strict separation between:

1. **Canonical transcript** — full-fidelity messages persisted to storage.
2. **Derived prompt view** — the ephemeral message list sent to the model for the current turn.

Reins should persist full tool results, but prune older tool results when building the in-flight prompt.

## Why this split matters

Persisting full results preserves:

- complete UI history
- debugging and auditability
- exports and replay
- future summarization / compaction improvements
- ability to rebuild prompts differently for different providers

Pruning only the prompt view preserves:

- lower prompt token cost
- smaller context payloads
- more room for fresh context
- provider-specific optimization without destructive data loss

## Proposed behavior

### Storage

- Keep all original user, assistant, tool call, and tool result messages in storage.
- Do **not** overwrite persisted tool results with pruned versions.
- If we later add summaries or compaction artifacts, store them as new derived records rather than destructive edits.

### Prompt building

Before each provider call:

1. Load canonical messages.
2. Apply any compaction or summary transforms.
3. Apply provider-aware pruning to old tool results.
4. Optionally drop old thinking blocks.
5. Send the resulting prompt to the provider.

This means prompt construction becomes an explicit pipeline rather than just "load messages and send them".

## Anthropic-specific first pass

A reasonable starting point is Anthropic cache-aware pruning similar to OpenClaw:

- track last cache-touch timestamp for the session
- while cache is warm, keep history intact
- after cache TTL expiry, begin pruning old tool results
- protect the recent tail of the conversation (for example, last few assistant turns)
- prefer soft trimming before hard clearing

Possible heuristic:

- **warm cache**: no pruning
- **expired cache + moderate context usage**: trim large old tool results to head/tail excerpts
- **expired cache + high context usage**: replace old tool results with a placeholder

## Open design questions

1. **Where to track cache freshness**
   - session row metadata
   - in-memory runner state
   - provider-specific turn metadata

2. **What exactly is prunable**
   - only tool results?
   - old thinking blocks?
   - large assistant text blocks?

3. **How much recent history to protect**
   - protect the last N assistant turns
   - protect from the last user turn onward
   - protect tool results tied to unfinished threads

4. **Whether pruning should be provider-aware**
   - Anthropic can use cache TTL
   - other providers may need simpler size-based heuristics

5. **How pruning interacts with compaction**
   - pruning is a per-turn prompt optimization
   - compaction is a more structural history reduction strategy
   - these should compose cleanly

## Suggested implementation shape in Reins

- Introduce a prompt-building layer/function for session runs.
- Keep persistence APIs returning canonical messages.
- Apply pruning only inside the provider request path.
- Make pruning policy configurable per provider / model.
- Add logging/inspection so we can tell when and how much content was pruned.

## Non-goals for the first pass

- mutating stored transcripts
- exposing pruning artifacts in the main chat UI
- solving full session memory / compaction design
- building a universal policy for every provider up front

## Next steps

1. Trace where Reins currently builds provider input from stored session messages.
2. Identify the cleanest insertion point for a prompt transformation pipeline.
3. Start with Anthropic-only pruning of old tool results.
4. Add instrumentation so we can compare prompt size before/after pruning.
5. Decide whether cache TTL should be tracked explicitly or inferred from last provider call time.
