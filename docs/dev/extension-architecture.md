# Extension Architecture

Reins is intended to be a platform that users can extend beyond the use cases anticipated by its maintainers. Extensibility is therefore a current architectural requirement, not a future concern that begins only after a second built-in implementation appears.

This document sets the direction for new work. It does not yet define a complete extension SDK, packaging format, or compatibility policy.

## Default posture

When adding a product capability, identify the smallest Reins-owned interface through which that capability can be provided. The built-in behavior should be an adapter at that seam rather than privileged behavior wired directly into callers.

A third-party implementation does not need to exist before establishing the seam. Unknown third-party use cases are part of the reason for the seam.

This does not mean exposing every helper or making all implementation details configurable. Extend product capabilities, not incidental mechanics. Keep algorithms, rendering details, caches, and orchestration private behind small interfaces.

## Contract rules

Extension-facing interfaces must:

- Use Reins-owned domain values. Do not expose framework, vendor, database, transport, route, DOM, or filesystem implementation types.
- Be asynchronous when an adapter may reasonably perform I/O, cross a process boundary, prompt a user, or defer work. A synchronous built-in implementation is not evidence that the contract is inherently synchronous.
- State lifecycle, ordering, concurrency, cancellation, error, and performance expectations in addition to TypeScript shapes.
- Prefer capability-oriented operations and returned results over exposing mutable implementation objects.
- Keep identity stable and explicit wherever values may be persisted or referenced across sessions.
- Support capability discovery when an operation may not be implemented, rather than relying on failed calls as feature detection.
- Avoid assuming that an extension shares the backend process, frontend framework, database, or trust level of the built-in adapter.

Do not leak a dependency into a contract merely because the first adapter uses it. For example, a diff extension contract should use Reins line and file values rather than `@pierre/diffs` metadata, and a runtime contract should expose normalized Reins events rather than provider-native events.

## Built-ins use the same seams

Where practical, the built-in implementation must be registered, selected, and invoked through the same interface intended for extensions. This keeps the extension path exercised and prevents a nominal SDK from becoming a less capable parallel path.

Composition belongs at an explicit composition root or registry. Callers should depend on the capability interface rather than directly constructing a replaceable adapter. Defaults may be selected centrally, but should not be embedded throughout feature code.

Do not add an extension layer that only forwards every method to an existing concrete implementation. The interface should hide implementation complexity and give callers leverage. If a proposed interface is as complicated as the implementation, redesign the capability or defer publishing that contract.

## Interface maturity

Not every internal seam is immediately a supported public contract. Use these stages deliberately:

1. **Reins-owned seam** — vendor-independent values and an explicit interface used by built-in code.
2. **Extension contract** — documented lifecycle and behavior, registration, validation, and failure handling.
3. **Supported SDK contract** — versioned compatibility expectations, migration policy, and public developer documentation.

Design new seams so they can progress through these stages without exposing implementation types. Do not claim compatibility guarantees before the contract reaches the supported SDK stage.

Existing features may be migrated incrementally. New work should avoid making migration harder, and significant new hardwiring of replaceable product behavior should be called out in the relevant plan or review.

## Design checklist

For a new or substantially changed capability, ask:

1. What capability is being provided, and what is the smallest useful interface for it?
2. Could an implementation live outside the current package, process, UI framework, or machine?
3. Are all inputs and outputs Reins-owned, serializable domain values where practical?
4. Which operations need promises, cancellation, progress, or subscriptions?
5. What stable identities cross persistence or remount boundaries?
6. How is the adapter registered and selected, and how are unsupported capabilities reported?
7. Does the built-in implementation use the same seam?
8. Which details can remain private so the interface stays small?
9. What compatibility commitment, if any, is being made today?

## Open design work

The broader extension design still needs decisions about loading and discovery, package distribution, frontend and backend contributions, permissions, trust and sandboxing, configuration, dependency compatibility, upgrades, and SDK versioning. Those decisions should be developed in an active extension plan and recorded in ADRs when they become durable architectural choices.
