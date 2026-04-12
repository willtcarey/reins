# Test File Structure

Tests should be organized to mirror the app/source folder structure.

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

## Scope

This is the default for backend and frontend code going forward. Existing non-mirrored tests can remain temporarily, but new tests should follow this structure.
