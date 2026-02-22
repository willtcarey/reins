# REINS — Tauri Shell

Native macOS wrapper that runs the REINS frontend in a system webview,
connecting to the backend on your dev node.

## Prerequisites

- macOS with Xcode Command Line Tools
- Rust toolchain: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Tauri CLI: `cargo install tauri-cli --version "^2"`

## Usage

Make sure the backend is running on your dev node, then:

```sh
# From the repo root
REINS_BACKEND_URL=http://<your-tailscale-host>:3100 bun run --filter tauri dev
```

This opens a native window pointing at the backend. Cmd+R refreshes.
Devtools are available in dev mode (right-click → Inspect Element).

## Building a .app bundle

```sh
REINS_BACKEND_URL=http://<your-tailscale-host>:3100 bun run --filter tauri build
```

Output lands in `src-tauri/target/release/bundle/`.

## How it works

The Tauri app is ~20 lines of Rust. It opens a webview that loads
the page from the backend URL — the backend already serves the
frontend files. No local assets, no proxy, no IPC.

`REINS_BACKEND_URL` defaults to `http://localhost:3100` if unset.
