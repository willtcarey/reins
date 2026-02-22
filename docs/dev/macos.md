# macOS App

The `packages/macos/` directory contains a SwiftUI app that runs the REINS
frontend in a native WKWebView. It connects to the backend over the
network — no local asset serving or build pipeline involved.

## How It Works

A lightweight SwiftUI app opens a WKWebView pointing at a backend URL.
The URL is resolved in this order:

1. **Runtime env var** — `REINS_BACKEND_URL` at launch (highest priority)
2. **Compile-time build setting** — `REINS_BACKEND_URL` baked into the app via Info.plist
3. **Default** — `http://localhost:3100`

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

## Setting the Backend URL at Build Time

Pass the build setting to `xcodebuild`:

```sh
xcodebuild -project packages/macos/Reins.xcodeproj -scheme Reins \
  REINS_BACKEND_URL='http://myhost:3100' build
```

Or set it in the Xcode build settings UI under the Reins target. The value
is baked into Info.plist at compile time. A runtime `REINS_BACKEND_URL`
environment variable still takes priority.

## Building a .app Bundle

```sh
xcodebuild -project packages/macos/Reins.xcodeproj -scheme Reins -configuration Release build
```

## Key Features

- **Cmd+R reload** — refreshes the webview
- **Configurable backend URL** — compile-time build setting with runtime env var override
- **JS-to-Swift messaging** — `WKScriptMessageHandler` bridge for future
  native features (notifications, etc.)
