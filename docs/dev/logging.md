# Logging

Backend app code should use `logger` from `packages/backend/src/logger.ts` instead of calling `console` directly. Oxlint enforces this under `packages/backend/src/**/*.ts`, excluding `logger.ts` itself and tests.

## Levels

- `logger.debug(...)` — verbose diagnostics.
- `logger.info(...)` — routine lifecycle output that is useful while running the server, such as startup, migrations, WebSocket connect/disconnect, or background task completion.
- `logger.warn(...)` — unexpected but recoverable conditions.
- `logger.error(...)` — failures that need attention.

## Test behavior

Bun sets `NODE_ENV=test` during `bun test`. In that environment, the logger suppresses `debug` and `info` output so routine tests stay scannable, while `warn` and `error` still print useful failure context.

Use `logger.info()` for logs that should be visible during normal server runs but hidden from routine test output. Use `logger.warn()` or `logger.error()` only when the output should remain visible during tests.

## Request timing

`handleFetch` (`handler.ts`) logs one line per HTTP request: `METHOD path status durationMs` (for example `GET /api/sessions/abc/messages 200 812ms`). Requests that take 300ms or more log at `info`, so they show in the normal dev log; faster ones log at `debug`. The duration runs until the route returns its response (its headers), not until the body is sent. The query string is left out, since it can carry tokens. The status is `upgraded` for a WebSocket upgrade and `threw` when the route threw.

When the UI hangs and no slow line shows, the time went to the network, a proxy or the browser, not the server.

## Runtime configuration

Outside tests, the default level is `info`. Set `REINS_LOG_LEVEL` to `silent`, `error`, `warn`, `info`, or `debug` to adjust verbosity.
