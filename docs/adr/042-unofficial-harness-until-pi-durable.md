# ADR-042: Take AgentHarness from the unofficial `@taco-ai/pi-harness` until pi-durable is stable

- **Status:** Accepted
- **Date:** 2026-11-17
- **Author:** Will (with Claude)

## Context

Reins' sessions run on Pi's AgentHarness ([ADR-029](029-sessions-on-the-server-nodes-host-tools.md)): its lanes, its session storage over Reins' database, its compaction, its tools and, on nodes, its execution environment. Pi 1.0 removed the harness from `@earendil-works/pi-agent-core`; its successor, `@earendil-works/pi-durable`, is marked experimental and its API changes between releases. Reins stayed on 0.99.2, the last official line with the harness.

Staying there costs more with each release. pi.dev's model catalog gives new models (Claude Fable 5.2) only to Pi 1.3 and later, so Reins' model list was frozen, and 1.x has many provider fixes (Anthropic OAuth's client version, OpenRouter context limits, Bedrock and Anthropic thinking signatures, OAuth refreshes cut off by a stop).

`@taco-ai/pi-harness` (npm; github.com/niuma996/pi-harness) is 0.99.2's `pi-agent-core` with its harness, extracted and kept running on the current pi-ai, chord and pi-telemetry. Checked before adopting 0.2.1:

- **Its code** against `pi-agent-core` 0.99.2's source: the agent loop, lanes, storage, values, compaction and tools are the same files. What differs is what pi-ai 1.x needed: chord import paths, telemetry passed under pi-ai's new option name, the assistant-message frame API (removed from pi-ai 1.3) as a frozen copy of 0.99.2's, a stream observer's failure aborting its request, and `listDir` skipping a vanished entry. The session format is the same (Reins' rows written by 0.99.2 open, resume and continue on it, and the reverse).
- **Its upkeep:** one maintainer, no other users that show (no stars, issues or dependents); four releases since 2026-10-19, with tests (the harness suite, the storage conformance suite, a packed-consumer check) in CI. It followed Pi 1.5.0 in 2 days and 1.5.2 in 3. It pins its peers to exact versions, so a Pi release reaches Reins only with a harness release that names it. Its README says it retires once pi-durable is stable.

## Decision

**Reins takes the harness from `@taco-ai/pi-harness`, pinned exactly, and the rest of Pi (pi-ai, pi-coding-agent, chord, pi-telemetry) at the version its peers name**, until pi-durable is stable. Every former `pi-agent-core` import, in the backend and the node, moves to the same subpath of the package; no Reins code is adapted to it beyond pi-ai 1.x's own changes (`Type` imported from `typebox`). Reins does not depend on `pi-agent-core`.

Moving to pi-durable stays the plan ([docs/TODO.md](../TODO.md)); this choice only changes where the 0.99.2 harness comes from meanwhile.

## Options considered

- **Stay on Pi 0.99.2.** Rejected: no new models from pi.dev and none of 1.x's provider fixes, for as long as pi-durable stays experimental.
- **Move to pi-durable now.** Rejected for now: experimental, its API changing between releases, and a different design (one process owns a storage, tools reach files and processes through a per-call `ExecutionEnv`), so a rewrite of the session runtime that would be redone as it changes.
- **Vendor the 0.99.2 harness into Reins** (or fork the package). Not now: the same code, but Reins would carry its fixes for each pi-ai release. Kept as the way out if the package stops following Pi.

## Consequences

- Reins depends on one person's package for its session runtime. Its diff from 0.99.2 is small and reviewable at each upgrade (diff it against the previous release, as above); the package is MIT and its source is 0.99.2's, so it can be vendored if it stalls.
- A Pi upgrade waits for a harness release naming that Pi, and moves pi-ai, chord and pi-telemetry together with it.
- Sessions need no migration in either direction, so going back to 0.99.2 is a dependency change.
- The session format is frozen at 0.99.2's (the package's rule). pi-durable's storage is another design; moving to it will need its own migration of stored sessions.
