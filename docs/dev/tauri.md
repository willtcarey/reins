# Tauri Desktop Wrapper

`packages/tauri/` contains the Tauri v2 desktop wrapper for REINS. It is an optional entrypoint alongside the web app and is the repository's only native desktop shell.

## Architecture

The desktop app creates one native window titled `REINS` and loads the backend URL as an external webview URL. It does not package frontend assets, run the backend, or proxy API traffic.

```text
Tauri window -> http://localhost:3100/ (or REINS_BACKEND_URL)
```

Because the page origin is the backend origin, existing relative `/api` requests and `/ws` WebSocket connections continue to work.

## Backend URL resolution

The wrapper resolves the backend URL in this priority order:

1. Runtime `REINS_BACKEND_URL`
2. Build-time `REINS_BACKEND_URL` captured by Rust's `option_env!("REINS_BACKEND_URL")`
3. `http://localhost:3100`

An invalid URL fails at startup with an explicit `REINS_BACKEND_URL` error.

## Local development

Do not change the normal local startup flow:

```sh
bun run dev
```

Then launch Tauri separately:

```sh
bun run tauri
# or point at another backend
REINS_BACKEND_URL=http://dev-node:3100 bun run tauri
```

`bun run start` still builds frontend assets and starts the backend; the desktop app remains a separate optional wrapper.

The native menu bar includes standard app/edit/window menus plus a View menu. View → Reload reloads the webview with Cmd+R on macOS and Ctrl+R on Windows/Linux. View → Toggle Developer Tools opens/closes the web inspector with Cmd+Option+I on macOS and Ctrl+Alt+I elsewhere.

Same-origin links stay inside the webview. External `http`/`https` navigations open in the system browser instead of replacing the REINS app view.

Downloads open a native save dialog instead of silently saving to the default downloads folder. Canceling the dialog cancels the download.

The Tauri window disables Tauri's native drag/drop handler so the loaded web app receives standard browser `DataTransfer.files` events when images are dropped onto the composer. This keeps chat image attachment drag/drop behavior consistent with the browser build. Normal file inputs use the system webview's native picker.

The frontend does not call the legacy macOS shell's notification bridge. The Tauri wrapper therefore preserves current web notification behavior but does not add a native notification plugin or remote-page IPC access.

## Packaging

```sh
bun run tauri:build
```

To bake in a default backend URL for a package, set `REINS_BACKEND_URL` when building. A runtime environment variable still takes priority when launching the app.

```sh
REINS_BACKEND_URL=http://myhost:3100 bun run tauri:build
```

The Tauri config intentionally omits `beforeDevCommand`, `beforeBuildCommand`, and `frontendDist` so packaging does not imply bundled frontend files.

## Platform prerequisites

### macOS

- Xcode Command Line Tools
- Rust toolchain
- Bun dependencies installed with `bun install`

The macOS bundle currently allows arbitrary HTTP loads because the backend URL is runtime-configurable and often points at localhost, LAN, or Tailscale hosts. Release builds also enable Tauri's `devtools` feature so the View menu can expose Web Inspector.

The macOS CI workflow builds unsigned Tauri bundles and uploads the generated `.app` and `.dmg` artifacts. Signing and notarization are not configured.

### Windows (future)

- Rust MSVC toolchain
- Visual Studio Build Tools
- WebView2 Runtime

PowerShell runtime URL example:

```powershell
$env:REINS_BACKEND_URL = 'http://host:3100'
bun run tauri
```

## Distribution and security gaps

Before distributing the wrapper broadly:

- configure macOS code signing and notarization;
- narrow the permissive CSP and macOS ATS settings while retaining an explicit way to connect to approved HTTP development backends;
- disable release devtools unless they are deliberately required;
- add an updater and release-channel process if automatic desktop updates are desired;
- add a Tauri notification plugin only if the frontend gains a concrete native-notification contract; and
- validate and package Windows/Linux targets in platform-specific CI before claiming support.
