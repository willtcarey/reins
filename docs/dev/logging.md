# Logging

Backend app code should use `logger` from `packages/backend/src/logger.ts` instead of calling `console` directly. Oxlint enforces this under `packages/backend/src/**/*.ts`, excluding `logger.ts` itself and tests.

## Levels

- `logger.debug(...)` — verbose diagnostics.
- `logger.info(...)` — routine lifecycle output that is useful while running the server, such as startup, migrations, WebSocket connect/disconnect, or background task completion.
- `logger.warn(...)` — unexpected but recoverable conditions.
- `logger.error(...)` — failures that need attention.

## Line format

Every line starts with its time in square brackets: ISO 8601 in the server's local time zone, with milliseconds and without the zone (`[2026-11-12T12:45:03.123]`, `localIsoTime`; set `TZ` to change the zone), then the arguments as `console` prints them. The time lets a slowdown or an error be matched to when it happened.

## Test behavior

Bun sets `NODE_ENV=test` during `bun test`. In that environment, the logger suppresses `debug` and `info` output so routine tests stay scannable, while `warn` and `error` still print useful failure context.

Use `logger.info()` for logs that should be visible during normal server runs but hidden from routine test output. Use `logger.warn()` or `logger.error()` only when the output should remain visible during tests.

## Request timing

`handleFetch` (`handler.ts`) logs one line per HTTP request: `METHOD path status durationMs` after the time (for example `[2026-11-12T12:45:03.123] GET /api/sessions/abc/messages 200 812ms`). Requests that take 300ms or more log at `info`, so they show in the normal dev log; faster ones log at `debug`. The duration runs until the route returns its response (its headers), not until the body is sent. The query string is left out, since it can carry tokens. The status is `upgraded` for a WebSocket upgrade and `threw` when the route threw.

A line also says where the time went, when it can (`request-timing.ts`): the request's timed phases, added up by name, the slowest first (each git command as `git <command>`, `git diff (untracked)` for a diff with untracked files; `parse numstat`; and `sqlite`, every statement the request ran on any database, added up as one, `database.ts`), and how long the event loop was blocked while the request ran, sampled every 20ms only while requests are in flight: `GET /api/sessions/abc/diff/files 200 812ms (git diff (untracked) 640ms, git rev-parse ×2 60ms, sqlite ×4 2ms; event loop lag 13ms)`. The lag counts any synchronous work while the request ran, its own included: a high lag with a large `sqlite` (or other synchronous) phase is the request's own work; a high lag without one is other work in the server process. A total far above its phases and lag went to something not timed yet. The detail is left out when the request has no phases and the lag is under 20ms. Mark other slow work with `timed(name, fn)` (or `timedSync`); outside a request it only runs `fn`. A request that throws logs no detail.

When the UI hangs and no slow line shows, the time went to the network, a proxy or the browser, not the server.

## Runtime configuration

Outside tests, the default level is `info`. Set `REINS_LOG_LEVEL` to `silent`, `error`, `warn`, `info`, or `debug` to adjust verbosity.
