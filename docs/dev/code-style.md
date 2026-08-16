# Code Style

- When writing comments, document the behavior that's there, not the path that we took to get there.
- Import from canonical source files instead of re-exporting through barrels or compatibility modules. The local oxlint plugin blocks `export { ... } from ...`, `export type { ... } from ...`, `export * from ...`, and exported type aliases that only rename another type. Primitive/composed aliases such as `export type LogLevel = "info" | "error"` remain valid.
- Define frontend SVG icons in `packages/frontend/src/components/icons.ts` and import their icon functions at call sites. The local oxlint plugin rejects inline `<svg>` markup and Lit `svg` templates elsewhere in frontend source.
- Create frontend `CustomEvent` instances in `packages/frontend/src/components/events.ts` and dispatch typed factory results from components. The local oxlint plugin enforces this for components outside the explicitly exempted legacy files in `.oxlintrc.json`; remove each exemption when that file is migrated.
