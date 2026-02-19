# ADR-004: SQLite Timestamps Must Include UTC Suffix

- **Status:** Accepted
- **Date:** 2026-02-19
- **Author:** Will (with Claude)

## Context

SQLite's `datetime('now')` returns strings like `2026-02-19 07:15:40` — UTC in
value but with no timezone indicator. When the frontend parses these with
`new Date(...)`, browsers treat the ambiguous string as local time. For users
not at UTC, this caused all relative timestamps (e.g. "just now", "5m ago") to
be wrong.

## Decision

**All SQLite timestamps must use ISO 8601 with an explicit `Z` suffix.**

In queries, use:

```sql
strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
```

instead of:

```sql
datetime('now')
```

This produces `2026-02-19T07:15:40.000Z`, which `new Date()` unambiguously
parses as UTC.

Column defaults in `CREATE TABLE` statements (baked into past migrations)
still use `datetime('now')`, so **INSERT statements must explicitly set
timestamp columns** rather than relying on defaults.

## Consequences

- Migration `009_timestamps_utc_suffix` retroactively appends `Z` to all
  existing timestamp values.
- All INSERT and UPDATE statements in store modules explicitly use the
  `strftime` form.
- New tables or timestamp columns should still declare a DEFAULT for schema
  clarity, but inserts must not rely on it.
