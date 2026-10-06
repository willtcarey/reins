# Test File Structure

Tests should be organized to mirror the app/source folder structure and should describe stable behavior contracts.

## Rule

Backend tests mirror source paths under `src/__tests__/`; node-package tests live alongside their module under `packages/node/src/`, and so do the shared packages' (`packages/node-protocol/src/`, `packages/telemetry/src/`, `packages/client/src/`; `bun test ./src` in each). Tests of the root `scripts/` live in `scripts/__tests__/` (`bun test ./scripts`, part of `bun run test`). Server–node integration tests live under backend `__tests__` and reach a node only over a link: an in-process node or a scripted fake over the loopback test link (`__tests__/helpers/loopback-node.ts`, `fake-node.ts`), or real child processes (`__tests__/helpers/processes.ts`, used only by process tests; see *Process tests*). A scenario that spans several modules with no single-module home (a command's replay across the outbox, the node and startup recovery; a session's whole life across a node restart) goes in `__tests__/integration/`, named for the scenario; everything else is tested at the interface of the module it belongs to, through its caller only when that is the honest boundary, and a contract is covered once.

- Node source: `packages/node/src/runtime/pi-runtime.ts`
- Node test: `packages/node/src/runtime/pi-runtime.test.ts` (over the server's storage through `RemoteStorage` and a test storage server, `packages/node/src/testing/storage-server.ts`, which holds each session in Pi's storage in memory (`testing/memory-storage.ts`, checked against Pi's storage conformance suite); backend tests do not exercise node runtime code on its own)

- Source: `src/routes/models.ts`
- Test: `src/__tests__/routes/models.test.ts`

## Why

- Makes ownership obvious (you can find tests from file path alone).
- Keeps test growth manageable as the codebase grows.
- Reduces ambiguous test buckets like `misc` or large flat folders.

## Process tests

The default suite (`bun run test`) is the feedback loop for every change and must stay fast, so it runs in-process only. A test that starts real processes (the entrypoints, the supervisor, a node child) is named `<module>.process-test.ts` next to where its `.test.ts` would be; `bun test` does not discover that name, and `bun run test:process` (repo root, or `packages/backend`) runs them. Today: `server-process.process-test.ts`, `supervisor.process-test.ts` and `index.process-test.ts`. A module's fast tests stay in its `.test.ts` (e.g. `supervisor.test.ts` covers the service table without starting anything). Prefer an in-process test (a loopback or fake node); write a process test only for behavior that needs a real process boundary (signals, crashes, restarts, the real socket, hot reload).

Talk to a started server through `ServerApi` (same file): its `client` is `@reins/client` on the server's port, plus helpers for setup, transcripts and browser WebSockets. Start children through `Child` (or `startServer`/`startNodeProcess`) in `__tests__/helpers/processes.ts`, and call `stopChildren()` first in the file's `afterEach` (a hook registered by the helper would attach only to the first file that imports it). Each child runs detached in its own process group and is recorded at spawn, so a child whose start times out is cleaned up too: `stopChildren` sends the child SIGTERM (so the supervisor stops its own services), then SIGKILLs whatever is left of its group. `Child.stop` signals the child alone. If the runner dies first, even by SIGKILL, a watchdog (`helpers/process-reaper.ts`, in its own session, told of every group and temp directory over its stdin) kills the groups and removes the directories when its stdin closes; only killing the watchdog too leaves them behind. Give any other real process its own `REINS_PORT` (`0`), `REINS_NODE_SOCKET` and temp `HOME`, so it never meets a running dev server.

Run `bun run test:process` when you touch entrypoints, the supervisor, the node link or process lifecycle (startup, shutdown, reconnect, recovery, hot reload), and before merging a branch.

## Conventions

- Use one `*.test.ts` file per source module or logical unit.
- Keep shared test utilities in `src/__tests__/helpers/`.
- If a legacy test is in a flat location, move it when you touch that area.
- Prefer path-preserving renames over creating new ad-hoc test files.

## Test Quality

Prefer tests at stable boundaries rather than at implementation seams.

Good boundaries include:

- Backend route/API responses and persisted database effects through public store/model functions.
- Node runtime event streams, wire methods, and message normalization outputs.
- Frontend store state transitions through public store methods.
- Component DOM events, rendered output, and public methods/properties.
- Exported pure helpers only when they encode a reusable contract that is awkward to reach through a higher boundary.

Avoid tests that depend on private implementation details, such as `Reflect.get()` access to private fields, `callPrivate()` helpers, internal render fragments, or exact intermediate state that users and callers cannot observe. Use those only when there is no practical boundary and document why.

Do not add negative tests whose only purpose is proving that an old implementation, method, or UI value is gone. Describe and assert the positive long-term contract at the caller or user boundary instead. Negative assertions remain appropriate when absence itself is the stable contract, such as authorization, validation, or preventing duplicate user-visible output.

Test contracts, not every permutation:

- Cover the happy path.
- Cover one meaningful empty/error path.
- Cover edge or boundary values where behavior changes.
- Do not split `undefined`, missing, empty, and invalid inputs into separate tests unless they produce meaningfully different behavior.
- Merge adjacent micro-tests into one scenario when they assert the same contract.

Avoid duplicate coverage across layers. If a route test verifies request validation, the lower-level store/model test should focus on persistence or domain semantics rather than repeating every validation case. If a component test covers rendered output, helper tests should cover only the non-obvious transformation contract.

Dense matrix tests are appropriate for parsers, security checks, path validation, protocol translators, and algorithms where small input differences define the public contract. For ordinary UI formatting and store plumbing, keep the suite boundary-focused and compact.

When changing behavior, update tests to match the new contract and remove or merge redundant tests in the same area. Do not only add new tests on top of stale coverage.

### Test Review Checklist

Before adding or keeping a test, ask:

- Would this test survive an internal refactor?
- Would it fail for a user-visible or contract-visible regression?
- Is this the closest stable boundary for the behavior?
- Is another layer already covering the same contract?
- Can several nearby micro-tests be collapsed into one clearer scenario?

## Scope

This is the default for backend and frontend code going forward. Existing non-mirrored tests can remain temporarily, but new tests should follow this structure and quality guidance.
