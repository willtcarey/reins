# Plan: Tauri Shell for Native Mac App

## Goal

Wrap the REINS frontend in a native macOS app using Tauri v2 so it runs
in a system webview instead of a browser tab. The backend stays on the dev
node (reachable over Tailscale); the Tauri app just points at it.

## Current Architecture

```
Browser ──► Backend (port 3100)
              ├─ GET /           → serves index.html + static assets
              ├─ GET /api/...    → REST endpoints
              └─ WS  /ws        → WebSocket (session events)
```

The frontend uses **relative URLs** everywhere (`/api/...`, `/ws`), derived
from `location.host`.

## Approach: Remote-Backend Webview

The simplest integration: the Tauri webview loads the page directly from the
remote backend URL (e.g. `http://devbox:3100/`). No local asset serving, no
proxy layer — the backend already serves the frontend files and handles CORS
implicitly (same origin).

This means:

- **Zero frontend changes** — relative URLs just work because `location.host`
  is the backend host.
- **No Tauri-side proxy or IPC** needed.
- **No local build of the frontend** required on the Mac — the backend serves
  it.
- Hot reload during development works the same as in a browser.

The backend URL is configurable (defaults to `http://localhost:3100` for local
dev, overridden to the Tailscale hostname for remote use).

## Project Structure

```
packages/tauri/
├── src-tauri/
│   ├── Cargo.toml          # Tauri deps
│   ├── tauri.conf.json     # App config (window size, title, etc.)
│   ├── src/
│   │   └── main.rs         # Minimal — just boot Tauri
│   ├── icons/              # App icons
│   └── Info.plist          # macOS metadata (optional overrides)
├── package.json            # Scripts: dev, build
└── README.md
```

This lives in the monorepo as `packages/tauri` but has no dependency on the
other workspace packages at build time — it's a standalone Tauri project that
happens to point its webview at the backend.

## Key Decisions

### 1. Window loads remote URL, not local files

Tauri v2 supports `WebviewUrl::External(url)` to point the webview at a
remote server. We use this instead of bundling the frontend into the app.

**Trade-off:** Requires the backend to be running and reachable. This is fine
for our use case (the app is useless without the backend anyway).

### 2. Backend URL configuration

The backend URL is set via:

1. Environment variable `REINS_BACKEND_URL` at build/launch time.
2. Fallback to `http://localhost:3100`.

In `main.rs` we read the env var and pass it as the webview URL. For
distribution, we can bake in a default or add a simple connection screen
later.

### 3. Tauri v2 (not v1)

Tauri v2 is stable, has better macOS support, and is the actively developed
version. No reason to use v1.

### 4. Minimal Rust surface

The `main.rs` is ~20 lines. No Tauri commands, no IPC, no plugins initially.
The app is literally "open a webview pointing at a URL with a nice window
frame." We can add native integrations (notifications, menu bar, global
shortcuts) later.

### 5. Monorepo integration

- `packages/tauri/package.json` provides `dev` and `build` scripts that
  shell out to `cargo tauri dev` / `cargo tauri build`.
- Root `package.json` gets a `tauri` script for convenience.
- The Tauri project is **not** a `@reins/*` workspace dependency of anything.

## Build & Dev Setup

### Prerequisites (Mac only)

- Xcode Command Line Tools
- Rust toolchain (`rustup`)
- `cargo install tauri-cli` (or use `bunx @tauri-apps/cli`)

### Dev workflow

```sh
# Terminal 1 — backend + frontend on dev node (or locally)
bun run dev

# Terminal 2 — Tauri app
REINS_BACKEND_URL=http://devbox:3100 bun run --filter tauri dev
```

`cargo tauri dev` opens the webview with devtools enabled.

### Production build

```sh
bun run --filter tauri build
```

Produces a `.app` bundle (and optionally `.dmg`) in
`packages/tauri/src-tauri/target/release/bundle/`.

## Security Considerations

- Tauri's CSP in `tauri.conf.json` needs to allow connecting to the backend
  origin (HTTP + WS).
- The backend is only reachable over Tailscale (private network), so no
  public exposure.
- No `dangerousRemoteDomainIpcAccess` needed since we don't use Tauri IPC.

## Future Enhancements (Out of Scope)

- **Connection screen:** A local HTML page that lets you enter/select the
  backend URL before connecting, stored in preferences.
- **Native menus:** Cmd+, for settings, standard Edit menu for copy/paste.
- **Auto-update:** Tauri's built-in updater for distributing new versions.
- **Notifications:** Native macOS notifications for long-running tasks.
- **Tray icon:** Show agent status in the menu bar.

## Implementation Steps

1. Scaffold Tauri v2 project in `packages/tauri/`.
2. Configure `tauri.conf.json` — window defaults, CSP, app metadata.
3. Write minimal `main.rs` that reads `REINS_BACKEND_URL` and opens the
   webview.
4. Add `package.json` with dev/build scripts.
5. Add convenience script to root `package.json`.
6. Test locally (backend on localhost) and remotely (backend over Tailscale).
7. Generate macOS app icons from existing favicon/logo.
8. Document in `packages/tauri/README.md`.
