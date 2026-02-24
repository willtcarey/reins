# ADR-005: Orchestrator Loop, Not Relay Chain for Delegation

- **Status:** Accepted
- **Date:** 2026-02-24
- **Author:** Will (with Claude)

## Context

The `delegate` tool lets an agent spawn a sub-session with a fresh context window to do a scoped unit of work. A natural question is how multi-step plans should execute — e.g. a plan with steps 1–5 where each step is its own sub-session.

Two models were considered:

### Relay chain (rejected)

Each sub-session delegates to the next at the end of its step:

```
Orchestrator → Step 1 → Step 2 → Step 3 → ...
```

Every link adds a nested stack frame. The orchestrator's `delegate` call is suspended waiting on step 1, which is suspended waiting on step 2, etc. A depth limit (e.g. 3) would cap the chain length, making it unsuitable for plans with more steps. Removing the depth limit risks runaway recursion with no practical bound.

### Orchestrator loop (accepted)

The orchestrator iterates over steps itself, delegating each one sequentially:

```
Orchestrator:
  delegate(step 1) → summary
  delegate(step 2) → summary
  delegate(step 3) → summary
```

Depth is always 1. The orchestrator's context grows only by compact summaries, not full working histories. The depth limit (2–3) serves as a guard against sub-sessions splitting their own work recursively, not as a chain length limiter.

## Decision

**Multi-step plan execution uses the orchestrator-loop pattern.** The orchestrating session (scratch or task) calls `delegate` repeatedly, one step at a time. Sub-sessions do their work and return — they do not chain to the next step.

Sub-sessions still receive the `delegate` tool so they can split their own work if needed, but the depth limit (default 3) prevents deep nesting. Sequential plan progression is the orchestrator's responsibility.

State handoff between steps happens via the file system (code changes, plan documents, notes) rather than conversation history. Each sub-session reads the current state of the repo and its instructions from the prompt.

## Consequences

- The `delegate` tool's depth limit is a recursion guard, not a chain limiter. Plans of any length can execute.
- Orchestrator context grows linearly with the number of steps, but only by summaries — much smaller than full tool-use histories.
- Sub-sessions are stateless relative to each other. They share state through the working tree, not through conversation threading.
- If an orchestrator's context does grow too large from many summaries, it can itself be a sub-session of a higher-level orchestrator — but this is an edge case, not the normal pattern.
