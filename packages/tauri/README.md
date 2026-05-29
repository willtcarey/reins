# REINS Tauri App

`packages/tauri` is a Tauri v2 desktop wrapper for REINS. It opens a native window and loads the REINS backend URL with `WebviewUrl::External`; it does not bundle frontend files or start the backend.

## Backend URL

The app resolves the backend URL in this order:

1. Runtime `REINS_BACKEND_URL`
2. Build-time `REINS_BACKEND_URL` baked into the Rust build via `option_env!`
3. `http://localhost:3100`

## Development

Start the normal REINS dev server in one terminal:

```sh
bun run dev
```

Then launch the desktop wrapper in another terminal:

```sh
bun run tauri
# or
REINS_BACKEND_URL=http://localhost:3100 bun run --filter '@reins/tauri' dev
```

The native View menu exposes Reload (Cmd+R on macOS, Ctrl+R on Windows/Linux) and Toggle Developer Tools (Cmd+Option+I on macOS, Ctrl+Alt+I elsewhere). Standard app, edit, and window menu items are also provided.

## Build

```sh
bun run tauri:build
```

To bake a default backend URL into the app while still allowing a runtime override:

```sh
REINS_BACKEND_URL=http://myhost:3100 bun run tauri:build
```

## Platform setup

- macOS: install Xcode Command Line Tools, Rust, Bun, and the Tauri CLI dependency with `bun install`. The bundle currently allows arbitrary HTTP loads so runtime-configured localhost/LAN/Tailscale backend URLs work. Release builds currently include Tauri's devtools support for the View menu's Web Inspector item.
- Windows (future): use the Rust MSVC toolchain, Visual Studio Build Tools, and WebView2 Runtime. Set a runtime URL in PowerShell with `$env:REINS_BACKEND_URL = 'http://host:3100'` before launching.
