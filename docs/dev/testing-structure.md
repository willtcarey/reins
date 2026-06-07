# Test File Structure

Tests should be organized to mirror the app/source folder structure and should describe stable behavior contracts.

## Rule

When you add or move code under `src/`, place tests in a matching path under `src/__tests__/`.

- Source: `src/runtimes/pi/runtime.ts`
- Test: `src/__tests__/runtimes/pi/runtime.test.ts`

- Source: `src/routes/models.ts`
- Test: `src/__tests__/routes/models.test.ts`

## Why

- Makes ownership obvious (you can find tests from file path alone).
- Keeps test growth manageable as the codebase grows.
- Reduces ambiguous test buckets like `misc` or large flat folders.

## Conventions

- Use one `*.test.ts` file per source module or logical unit.
- Keep shared test utilities in `src/__tests__/helpers/`.
- If a legacy test is in a flat location, move it when you touch that area.
- Prefer path-preserving renames over creating new ad-hoc test files.

## Test Quality

Prefer tests at stable boundaries rather than at implementation seams.

Good boundaries include:

- Backend route/API responses and persisted database effects through public store/model functions.
- Runtime adapter event streams and message normalization outputs.
- Frontend store state transitions through public store methods.
- Component DOM events, rendered output, and public methods/properties.
- Exported pure helpers only when they encode a reusable contract that is awkward to reach through a higher boundary.

Avoid tests that depend on private implementation details, such as `Reflect.get()` access to private fields, `callPrivate()` helpers, internal render fragments, or exact intermediate state that users and callers cannot observe. Use those only when there is no practical boundary and document why.

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
