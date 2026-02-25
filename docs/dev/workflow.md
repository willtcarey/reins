# Development Workflow

This is the implementation playbook. Read it before starting any code change.

## Before You Start

- Check for a planning doc in [`docs/plans/`](../plans/) for the work you're doing. Follow it.
- Read relevant [`docs/dev/`](./) docs for the area you're touching.
- Check [`docs/tech-debt.md`](../tech-debt.md) for known issues in the area.

## Red-Green-Refactor

Every new feature, behavior change, or bug fix starts with a failing test. No exceptions.

1. **Red:** Write a failing test that describes the desired behavior. Run `bun test --filter <test-file>` and confirm it fails for the right reason.
2. **Green:** Write the minimum code to make the test pass. Run the test again and confirm it passes.
3. **Refactor:** Clean up the implementation. Run the full suite with `bun test` to confirm nothing broke.

When changing existing behavior, update the test first to reflect the new contract (red), then update the code (green).

### Philosophy

- Tests describe **contracts** (inputs → outputs), not implementation details.
- Use **real dependencies** where cheap — SQLite in-memory is instant, temp git repos are fast.
- Only **mock expensive externals** (LLM calls, pi SDK sessions).

## Before You Finish

- Run `bun test` and confirm the full suite passes.
- Update or create docs:
  - [`docs/features/`](../features/) if user-facing behavior changed.
  - [`docs/dev/`](./) if internal conventions or architecture changed.
  - [`docs/dev/INDEX.md`](INDEX.md) if you added a new dev doc.
- Suggest tech debt items you noticed (don't add without confirmation).
- If a planning doc in [`docs/plans/`](../plans/) is fully implemented, move it to `docs/plans/completed/`.
