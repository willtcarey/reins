# macOS App

The `packages/macos/` directory contains a SwiftUI app that runs the REINS
frontend in a native WKWebView. It connects to the backend over the
network — no local asset serving or build pipeline involved.

## How It Works

A lightweight SwiftUI app opens a WKWebView pointing at a backend URL.
The URL is resolved in this order:

1. **Environment variable** — `REINS_BACKEND_URL` at launch
2. **Default** — `http://localhost:3100`

The backend already serves the frontend files, so relative URLs (`/api/...`,
`/ws`) just work.

## Prerequisites

- Xcode (with Command Line Tools)

## Running

Open `packages/macos/Reins.xcodeproj` in Xcode and run, or build from the
command line:

```sh
xcodebuild -project packages/macos/Reins.xcodeproj -scheme Reins -configuration Debug build
```

The backend must be running (locally or on the dev node).

## Reloading Frontend Changes

Cmd+R refreshes the webview. The frontend's `bun run dev` watcher rebuilds
on file changes; just refresh to pick them up.

## Building a .app Bundle

```sh
xcodebuild -project packages/macos/Reins.xcodeproj -scheme Reins -configuration Release build
```

## Key Features

- **Cmd+R reload** — refreshes the webview
- **Configurable backend URL** — via `REINS_BACKEND_URL` environment variable
- **JS-to-Swift messaging** — `WKScriptMessageHandler` bridge for future
  native features (notifications, etc.)
