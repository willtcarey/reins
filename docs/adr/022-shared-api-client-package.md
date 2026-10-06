# ADR-022: Tools Call the Server's HTTP API Through a Shared Client Package

- **Status:** Accepted
- **Date:** 2026-10-06
- **Author:** Will (with Claude)
- **Extends:** [ADR-014](014-shared-protocol-and-storage-packages.md) (a third shared package, with its own import boundary)

## Context

The only typed HTTP client was the frontend's `ReinsClient`: resource-oriented, with response types imported type-only from backend modules through the frontend's `@backend/*` path alias, an injectable fetch and `ReinsHttpError` carrying the server's `error` message. It was browser-bound (relative URLs, XHR uploads), so everything else hand-rolled `fetch`: the process tests' `ServerApi` and `bun run node:reload` ([ADR-021](021-explicit-node-reload.md)). That CLI once reported success against an older server, because the server answered every unknown path, `/api/*` included, with the web app's `index.html` and a 200.

More tools that talk to a running server are coming (CLIs, scripts, remote nodes once they authenticate), and each would otherwise repeat the paths, the error decoding and the guesswork about what a response means.

## Decision

**CLIs and tools call the server's HTTP API, through `@reins/client`.** The server is the only authority; there is no second entry point (a Unix-socket control listener was considered and rejected: a second protocol to keep in step with the routes, and of no use to a remote caller).

- `packages/client` holds `ReinsClient` and `ReinsHttpError` for the browser app, Bun scripts and tests. Options: `baseUrl` (omitted in the browser: relative paths), `fetch` (the injectable transport) and `upload` (a fetch that reports upload progress). Every request goes through one place, so authentication, when remote nodes need it, is one more option there.
- A response the client expects as JSON that is not JSON (wrong content type, unparseable, empty) is a `ReinsHttpError`, even on a 2xx: a caller never mistakes another server's page for success.
- The server answers an `/api` path that no route matches with a JSON 404 (`{error}`); only browser paths fall back to the web app.
- Response and request types stay backend-owned and are imported **type-only by package name**: `import type … from "@reins/backend/routes/nodes.js"`. `@reins/backend` exports `./*` → `./src/*` for that purpose and `@reins/client` lists it as a devDependency. Type resolution then follows `node_modules` from the client's own files, so any consumer (the frontend, the backend's tests, root scripts) type-checks the client with no path alias of its own.
- Upload progress needs XHR, which only browsers have. The client sends uploads through its `upload` transport (`fetch` without progress by default); the frontend passes an XHR transport that resolves with a `Response`, so error decoding stays in the client.
- Enforced by `reins/client-isolation` (Oxlint: runtime imports only of its own modules; `@reins/backend/*` and `@reins/telemetry` only with `import type`) and by a package test that bundles the client for the browser and finds only its own source in the bundle.

Rejected: the frontend's `@backend/*` path alias inside the package (every consumer's tsconfig would need the same alias, the backend's included); a generated client from an API schema (there is no schema; the routes and their exported types are the contract); keeping XHR inside the client behind a `typeof XMLHttpRequest` check (Bun callers would silently take another code path than the browser's).

## Consequences

- `@reins/backend` and `@reins/client` depend on each other at the package level (the backend's tests use the client; the client takes the backend's types). Bun installs and filters the cycle fine; at runtime only the backend's test helpers import the client.
- The frontend keeps its `api` instance (`models/api.ts`, with the XHR upload transport) and imports `ReinsHttpError` from `@reins/client`.
- A new endpoint that tools need is added to the client next to its route; the frontend gets it for free.
- Details: [frontend-architecture.md](../dev/frontend-architecture.md) *Data flow*, [router.md](../dev/router.md) *Unknown routes*.
