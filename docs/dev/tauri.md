# Tauri Shell

The `packages/tauri/` directory contains a Tauri v2 app that runs the REINS
frontend in a native macOS webview. It connects to the backend over the
network — no local asset serving or build pipeline involved.

## How It Works

The app is ~20 lines of Rust. On launch it reads `REINS_BACKEND_URL` (defaults
to `http://localhost:3100`) and opens a webview pointing at that URL. The
backend already serves the frontend files, so relative URLs (`/api/...`, `/ws`)
just work.

## Prerequisites (Mac only)

- Xcode Command Line Tools
- Rust toolchain: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Tauri CLI: `cargo install tauri-cli --version "^2"`

## Running

```sh
# Backend must be running (locally or on the dev node)
REINS_BACKEND_URL=http://<your-tailscale-host>:3100 bun run tauri
```

## Reloading Frontend Changes

Same as a browser — Cmd+R refreshes the webview. The frontend's `bun run dev`
watcher rebuilds on file changes; just refresh to pick them up.

## Devtools

Right-click → Inspect Element in dev mode, same as Chrome devtools.

## Building a .app Bundle

```sh
REINS_BACKEND_URL=http://<your-tailscale-host>:3100 bun run --filter tauri build
```

Output: `packages/tauri/src-tauri/target/release/bundle/`

## Key Files

| File | Purpose |
|---|---|
| `src-tauri/src/main.rs` | Reads backend URL, opens webview |
| `src-tauri/tauri.conf.json` | App metadata, CSP, window config |
| `src-tauri/Cargo.toml` | Rust dependencies (Tauri v2) |
| `package.json` | `dev` / `build` scripts wrapping `cargo tauri` |
