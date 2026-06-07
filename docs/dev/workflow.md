# Development Workflow

This is the implementation playbook. Read it before starting any code change.

## Before You Start

- Check for a planning doc in [`docs/plans/`](../plans/) for the work you're doing. Follow it.
- Treat files in [`docs/plans/completed/`](../plans/completed/) as historical records: do not edit completed plans for follow-up or unrelated changes; create or update an active plan or dev doc instead.
- Read relevant [`docs/dev/`](./) docs for the area you're touching.
- Check [`docs/tech-debt.md`](../tech-debt.md) for known issues in the area.

## Red-Green-Refactor

Every new feature, behavior change, or bug fix starts with a failing test. No exceptions.

1. **Red:** Write a failing test that describes the desired behavior. Run `bun test --filter <test-file>` and confirm it fails for the right reason.
2. **Green:** Write the minimum code to make the test pass. Run the test again and confirm it passes.
3. **Refactor:** Clean up the implementation. Run the full suite with `bun test` to confirm nothing broke.

When changing existing behavior, update the test first to reflect the new contract (red), then update the code (green).

For where tests should live, follow [testing-structure.md](testing-structure.md): tests should mirror the app/source folder structure.

### Philosophy

- Tests describe **contracts** (inputs → outputs), not implementation details.
- Prefer boundary tests that would survive an internal refactor and fail for user-visible or contract-visible regressions.
- Use **real dependencies** where cheap — SQLite in-memory is instant, temp git repos are fast.
- Only **mock expensive externals** (LLM calls, pi SDK sessions).
- Do **not** add defensive compatibility layers (fallback reads, dual-schema handling, etc.) unless explicitly requested by the user.
- When touching an area, remove or merge redundant tests instead of only adding new coverage.

## Before You Finish

- Run `bun test` and confirm the full suite passes.
- Run `bun run typecheck` and confirm there are no type errors.
- Run `bun run lint` and confirm there are no lint warnings.
- Update or create docs:
  - [`docs/features/`](../features/) if user-facing behavior changed — update an existing doc before creating a new one.
  - [`docs/dev/`](./) if internal conventions or architecture changed.
  - [`docs/dev/INDEX.md`](INDEX.md) if you added a new dev doc.
- Suggest tech debt items you noticed (don't add without confirmation).
- If a planning doc in [`docs/plans/`](../plans/) is fully implemented, move it to `docs/plans/completed/`.
