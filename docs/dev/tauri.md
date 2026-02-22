# Tauri Shell

The `packages/tauri/` directory contains a Tauri v2 app that runs the REINS
frontend in a native macOS webview. It connects to the backend over the
network — no local asset serving or build pipeline involved.

## How It Works

The app is ~20 lines of Rust. It opens a webview pointing at a backend URL.
The URL is resolved in this order:

1. **Compile-time** — if `REINS_BACKEND_URL` is set when building, it's baked in via `option_env!`
2. **Runtime env var** — `REINS_BACKEND_URL` at launch overrides the default
3. **Default** — `http://localhost:3100`

The backend already serves the frontend files, so relative URLs (`/api/...`,
`/ws`) just work.

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

## CI

The `.github/workflows/build-tauri-mac.yml` workflow builds the macOS `.app`
and `.dmg` on every tag push (`v*`). It can also be triggered manually from any
branch via `workflow_dispatch`. On tag pushes it creates a draft GitHub Release
with the `.dmg` attached. The `REINS_BACKEND_URL` GitHub secret is baked in at
compile time so release builds point at the production backend.

## Key Files

| File | Purpose |
|---|---|
| `src-tauri/src/main.rs` | Reads backend URL, opens webview |
| `src-tauri/tauri.conf.json` | App metadata, CSP, window config |
| `src-tauri/Cargo.toml` | Rust dependencies (Tauri v2) |
| `package.json` | `dev` / `build` scripts wrapping `cargo tauri` |
