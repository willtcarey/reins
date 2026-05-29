# Plan: Convert Mac App Back to Tauri

## Goal

Replace the current `packages/macos/` SwiftUI/WKWebView app with a Tauri v2
remote-webview desktop wrapper. The desktop app should load the existing REINS
web app from a backend URL instead of packaging frontend files into the desktop
bundle.

The existing local development behavior must stay intact:

- `bun run dev` continues to start the backend plus frontend watchers.
- `bun run start` continues to build frontend assets and start the backend.
- The web app remains served by the backend at `http://localhost:3100` by default.
- The desktop wrapper is an optional extra entrypoint that points at that server.

Future Windows support should be considered in structure and configuration, even
if this task only verifies/macOS-packages first.

## Background

The repo previously had a Tauri shell under `packages/tauri/` before it was
removed in favor of the SwiftUI macOS app. Useful historical commits:

- `a9b85d5` / `0013e1d`: initial Tauri v2 remote-webview shell with Cmd+R reload.
- `de6470c`: Tauri macOS build workflow, `Info.plist` ATS exception, build-time
  `REINS_BACKEND_URL` support.
- `90822e4`: removal of the Tauri app.

The current Swift app provides behavior we should preserve or consciously defer:

- Loads `REINS_BACKEND_URL`, falling back to `http://localhost:3100`.
- Supports a build-time backend URL baked into the app.
- Cmd+R reloads the webview.
- External `http(s)` links open in the default browser.
- File upload panels work via native picker.
- Downloads with `Content-Disposition: attachment` show a save panel.
- A JS-to-native notification bridge exists for future native notifications.

## Target Architecture

```text
Tauri app window ──loads──► REINS backend URL
                            ├─ GET /          frontend HTML
                            ├─ GET /dist/...  frontend assets
                            ├─ GET/POST /api  app API
                            └─ WS /ws         app events
```

The Tauri app should not run the backend, bundle frontend files, or proxy API
traffic. Because the page origin is the backend origin, existing relative API and
WebSocket URLs continue to work.

## Package Layout

Create `packages/tauri/`:

```text
packages/tauri/
├── package.json
├── README.md
└── src-tauri/
    ├── Cargo.toml
    ├── Cargo.lock                # commit for reproducible desktop builds
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json # if needed by Tauri v2 config
    ├── icons/
    └── src/main.rs
```

Eventually remove `packages/macos/` and replace docs/workflows that refer to it. For the current implementation slice, keep `packages/macos/` in place and add `packages/tauri/` alongside it.

## Implementation Plan

### 1. Restore/scaffold Tauri v2 shell

Start from the historical Tauri files, then modernize for the current repo and
Tauri v2 conventions.

Core Rust behavior:

- Resolve the backend URL from, in priority order:
  1. runtime `REINS_BACKEND_URL`,
  2. build-time/baked default if configured,
  3. `http://localhost:3100`.
- Validate that the URL parses and fail loudly with a useful error if not.
- Build one main webview window using `WebviewUrl::External(url)`.
- Preserve window defaults: title `REINS`, initial size around `1200x800`, min
  size at least `800x600`.
- Preserve reload shortcut: Cmd+R on macOS, Ctrl+R on Windows/Linux.

### 2. Preserve behavior from the Swift shell

Implement or verify these Tauri equivalents:

- **External links:** configure navigation handling so non-backend `http(s)` URLs
  open in the system browser instead of replacing the app view.
- **File uploads:** verify Tauri webview file input behavior on macOS. Add a
  plugin/config only if the default webview does not show the native picker.
- **Downloads:** verify attachment downloads. If Tauri does not give a save-panel
  experience by default, add the minimal Tauri download handling needed.
- **Notifications bridge:** do not recreate the custom JS bridge unless current
  frontend code depends on it. Prefer deferring native notifications to a future
  task using Tauri plugins.

### 3. Configure Tauri for remote backend loading

`tauri.conf.json` should make the remote-loading choice explicit:

- no frontend `beforeDevCommand`, `beforeBuildCommand`, or `frontendDist` that
  implies bundled app files;
- CSP allows the backend page/assets plus API/WebSocket connections (`http:`,
  `https:`, `ws:`, `wss:`), and keeps allowances no broader than necessary;
- macOS bundle includes ATS settings for `http://localhost:3100` and private LAN/
  Tailscale HTTP development URLs;
- bundle identifier stays stable (`net.reins.app` unless we decide otherwise);
- bundle targets include macOS now and are compatible with Windows later.

### 4. Wire npm/bun scripts without changing existing startup

Add `packages/tauri/package.json` with scripts such as:

```json
{
  "name": "tauri",
  "private": true,
  "scripts": {
    "dev": "cargo tauri dev",
    "build": "cargo tauri build"
  }
}
```

Add root convenience scripts without changing existing ones:

- keep `bun run dev` as backend + frontend watchers;
- keep `bun run start` as build + backend;
- add `bun run tauri` or `bun run desktop` for Tauri dev;
- optionally add `bun run tauri:build` for packaging.

Expected local development flow:

```sh
# terminal 1
bun run dev

# terminal 2
REINS_BACKEND_URL=http://localhost:3100 bun run tauri
```

For a dev node/Tailscale backend:

```sh
REINS_BACKEND_URL=http://<tailscale-host>:3100 bun run tauri
```

### 5. Replace macOS-specific docs and CI

Docs to update:

- Replace `docs/dev/macos.md` with a Tauri/desktop wrapper guide, or rename it to
  `docs/dev/tauri.md` / `docs/dev/desktop.md` and update `docs/dev/INDEX.md`.
- Update `README.md` package table and macOS app reference.
- Add `packages/tauri/README.md` with focused setup/build notes.

Document platform setup:

- macOS: Xcode Command Line Tools, Rust, Tauri CLI or `bunx @tauri-apps/cli`.
- Windows future: Rust MSVC toolchain, Visual Studio Build Tools/WebView2 runtime,
  PowerShell examples for setting `REINS_BACKEND_URL`.
- Linux future if we mention it: WebKitGTK dependencies.

CI/workflows:

- Replace `.github/workflows/macos-build.yml` with a Tauri macOS build workflow.
- Include Rust installation/cache and Tauri CLI installation.
- Build from `packages/tauri`.
- Upload `.app`/`.dmg` artifacts if generated.
- Keep signing/notarization out of scope unless credentials already exist.

### 6. Remove Swift macOS shell (deferred)

After the Tauri package has been verified and we are ready to cut over fully:

- delete `packages/macos/`;
- remove Xcode-only `.gitignore` entries if no longer needed, or keep harmless
  generic entries if we expect future native work;
- remove/replace Swift-specific docs and workflow references.

This is explicitly deferred for the first Tauri reintroduction slice.

### 7. Verification

Local checks:

- `bun run dev` still starts the existing local dev server/watchers.
- Browser access to `http://localhost:3100` still works.
- `REINS_BACKEND_URL=http://localhost:3100 bun run tauri` opens the app.
- Cmd+R/Ctrl+R reloads the app view.
- API calls and `/ws` WebSocket traffic work inside the Tauri webview.
- External links open outside the app.
- File upload and attachment download behavior is acceptable or documented.
- `bun run --filter tauri build` produces a macOS bundle.

Repo checks before finishing implementation:

- `bun test`
- `bun run typecheck`
- `bun run lint`

## Open Decisions

1. **Backend URL persistence:** for this task, use env/build-time defaults only.
   A UI to choose/save the backend URL can be a later task.
2. **Native notifications:** defer unless the frontend already calls the Swift
   message bridge in production paths.
3. **HTTP security posture:** allow HTTP for localhost/private dev URLs now;
   revisit stricter per-host ATS/CSP rules before distributing broadly.
4. **Windows timing:** keep the Tauri code cross-platform, but only require macOS
   packaging verification for this task unless Windows CI/build machines are
   available.
