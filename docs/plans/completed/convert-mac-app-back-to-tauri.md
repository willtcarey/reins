# Completed: Convert Mac App Back to Tauri

**Status:** Completed September 8, 2026

## Goal

Replace the SwiftUI/WKWebView app in `packages/macos/` with the Tauri v2 remote-webview wrapper while preserving the existing web/backend development and startup flows.

## Completed cutover

- `packages/tauri/` is the repository's only native desktop shell.
- The wrapper remains optional: `bun run dev` and `bun run start` are unchanged, while `bun run tauri` and `bun run tauri:build` launch and package the wrapper separately.
- The desktop window loads the configured backend directly and does not bundle frontend assets, start the backend, or proxy traffic.
- Backend URL resolution remains runtime `REINS_BACKEND_URL`, then a build-time value, then `http://localhost:3100`.
- Same-origin API and WebSocket traffic continue to use the backend page origin.
- Existing Tauri handling remains in place for external links, native file inputs, save-dialog downloads, menu/reload actions, drag/drop uploads, and focus visibility events.
- The frontend has no dependency on the old JS-to-Swift notification bridge. No remote-page Tauri IPC or native notification plugin was added.
- `packages/macos/`, its Swift sources, Xcode project/assets, Xcode-specific ignore rules, and its developer guide were removed.
- README, developer documentation, package references, and the developer-doc index now describe only the optional Tauri wrapper.
- The tag/manual macOS workflow now installs Bun and Rust, builds through the repository's `bun run tauri:build` command, caches Rust build output, and uploads unsigned `.app` and `.dmg` bundles.

## Resulting architecture

```text
Tauri app window ──loads──► REINS backend URL
                            ├─ GET /          frontend HTML
                            ├─ GET /dist/...  frontend assets
                            ├─ GET/POST /api  app API
                            └─ WS /ws         app events
```

The wrapper remains structured for future Windows/Linux support, but this cutover only configures macOS packaging CI.

## Verification

The cutover is verified with repository reference audits, Bun tests, typechecking, linting, Tauri CLI configuration checks, and Rust checks when Cargo is available. Normal web/backend scripts were intentionally not modified.

## Deferred distribution and security work

Signing/notarization, automatic updates, stricter release CSP/ATS policy, removing release devtools, optional native notifications, and platform-specific Windows/Linux packaging remain separate distribution concerns. They are documented in [`docs/dev/tauri.md`](../../dev/tauri.md) rather than added to the tech-debt tracker.
