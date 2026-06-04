# Code Style

- When writing comments, document the behavior that's there, not the path that we took to get there.
- Import from canonical source files instead of re-exporting through barrels or compatibility modules. The local oxlint plugin blocks `export { ... } from ...`, `export type { ... } from ...`, `export * from ...`, and exported type aliases that only rename another type. Primitive/composed aliases such as `export type LogLevel = "info" | "error"` remain valid.
