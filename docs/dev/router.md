# Backend Router & API Routes

## Architecture

The backend uses a lightweight URLPattern-based router (`src/router.ts`) with no external dependencies. Routes are organized by resource in `src/routes/`, composed together in `src/routes/index.ts`.

```
src/
  api-paths.ts          # All route path constants (single source of truth)
  errors.ts             # HttpError class + shorthand throwers, RequestRefused (a model's refusal: 400)
  router.ts             # createRouter(), URLPattern matching, middleware chaining
  routes/
    index.ts            # Composes all routes, defines shared middleware
    health.ts           # GET /api/health
    projects.ts         # CRUD /api/projects
    sessions.ts         # /api/projects/:id/sessions (project-scoped)
    diff.ts             # /api/projects/:id/diff (project-scoped)
    nodes.ts            # /api/nodes, and /nodes/*: the node link, install script, manifest, bundle
    sockets.ts          # GET /ws (the browser WebSocket upgrade)
```

Every HTTP endpoint is a route, those outside `/api` included; `handler.ts` only falls back to static files.

## Adding a New Route

1. **Add the resource root** to `src/api-paths.ts`.

   `api-paths.ts` should define route namespaces/resources, not every leaf endpoint under that resource.

   ```ts
   export const API = {
     // ...existing paths
     myThing: "/api/projects/:id/my-thing",
   } as const;
   ```

   For a multi-endpoint resource, add the shared prefix only:

   ```ts
   export const API = {
     // ...existing paths
     auth: "/api/auth",
   } as const;
   ```

2. **Create a route file** in `src/routes/` (one file per resource).

   Route files should register paths relative to their resource root when they are mounted under `router.group(...)` in `routes/index.ts`.

   ```ts
   // src/routes/my-thing.ts
   import type { RouterGroup, RouteContext } from "../router.js";

   export function registerMyThingRoutes(router: RouterGroup) {
     router.get("/items", async (ctx: RouteContext) => {
       // ...
       return Response.json({ ok: true });
     });

     router.post("/items", async (ctx: RouteContext) => {
       // ...
       return Response.json({ ok: true });
     });
   }
   ```

3. **Register it** in `src/routes/index.ts`.

   Group routes under the resource root from `api-paths.ts`, then keep the leaf paths inside the route file.

   ```ts
   import { registerMyThingRoutes } from "./my-thing.js";

   // Inside buildRouter():
   router.group(API.myThing, (r) => {
     registerMyThingRoutes(r);
   });

   router.group(API.project, projectMiddleware, (r) => {
     registerSessionRoutes(r);
     registerDiffRoutes(r);
   });
   ```

4. **Only use full paths in route files for true single-endpoint top-level routes.**

   If a route file represents a namespace with multiple endpoints, prefer:
   - `api-paths.ts` → resource root
   - `routes/index.ts` → `router.group(API.resource, ... )`
   - route file → relative leaf paths like `"/providers"`, `"/items/:id"`

## Project-Scoped vs Top-Level Routes

- **Top-level routes** (like `/api/projects`, `/api/health`) are registered directly on the router.
- **Project-scoped routes** (like a project's sessions, tasks, code reviews) are registered inside `router.group(API.project, projectMiddleware, ...)`. The middleware resolves `:id` to a project and attaches `ctx.project` (`ctx.models.project(id)`, a `ProjectModel`, whose `defaultSource` is the only location it has; 404 when it has none).
- **A session's checkout routes** (diffs, the files they show, git: what a session's views read or change of its checkout) are registered inside `r.group("/:sessionId", sessionMiddleware, ...)` under `API.sessions` (`/api/sessions/:sessionId/diff/files`, …). The middleware attaches `ctx.session` (`ctx.models.sessions.get(id)`, a `SessionModel`; 404 "Session not found: <id>"): its `source` (a `SourceModel`), its `baseBranch` (its project's, or `HEAD` for a session of no project, so its diffs show uncommitted work) and its `workspace` against it, so a session moved to another node shows that node's checkout. Skill suggestions are a location's, not a session's: `GET /api/nodes/:nodeId/skills?path=` (`routes/skills.ts`, top level), as the new session page has no session yet; so are a source's files, `/api/nodes/:nodeId/files…?root=` (`routes/files.ts`, top level), which any directory on a node is read through.

## Error Handling

The router wraps all handlers with a catch block. Don't use try/catch in handlers unless you need to transform a specific error. Instead:

```ts
import { badRequest, notFound, conflict } from "../errors.js";

// These throw HttpError and stop execution:
notFound("Project not found");      // 404
badRequest("name is required");     // 400
conflict("Already exists");         // 409

// Or throw directly for other status codes:
throw new HttpError(403, "Forbidden");
```

A model's refusal of what its caller asked (a subclass of `RequestRefused` in `errors.ts`, such as `SessionCreationRefused`) is returned as 400 with its message; let it propagate, as the models' other callers (scripts, extensions) get the same error. A node the request needed being unreachable (`isNodeUnavailable`: a `NodeClient` call's `RpcFailure` with code `"unavailable"`) is returned as 503; let it propagate rather than catching it. Other unexpected errors are caught automatically and returned as 500 with the error message.

## Unknown Routes

`handler.ts` tries the router first. An `/api` path (`/api` or under `/api/`) that no route matches, including a known path with another method, is answered `404 {"error": "No API route <METHOD> <path>"}`, and a `/nodes` path a plain-text `404 Not found`; only other paths fall back to static files and the web app (`static.ts`, SPA fallback to `index.html`). A client therefore never takes the web app for an API answer; `@reins/client` also treats any non-JSON success where it expects JSON as an error ([ADR-022](../adr/022-shared-api-client-package.md)).

## Request Validation

Use `src/routes/validate.ts` helpers for request parsing and shape validation instead of hand-rolled defensive checks in handlers. Routes should translate HTTP-specific shapes (`Request`, JSON bodies, `FormData`, uploaded `File`s) into plain model DTOs, then delegate to models.

Available helpers include JSON body validation (`parseBody`), multipart parsing (`parseFormData`), required file extraction (`parseFormFiles`), and URL integer params (`parseIntParam`).

## Router API

```ts
const router = createRouter();

router.get(path, handler);
router.post(path, handler);
router.patch(path, handler);
router.delete(path, handler);
router.websocket(path, handler);  // a GET that may upgrade to a WebSocket

// Groups: shared prefix + middleware
router.group("/api/projects/:id", projectMiddleware, (r) => {
  r.get("/sub-resource", handler);
});

// Handler signature:
async (ctx: RouteContext) => Response
// A websocket route's: undefined once it upgraded the request (Bun answers it), else its refusal
async (ctx: RouteContext) => Response | undefined

// RouteContext:
interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;  // extracted from URLPattern
  state: AppState;
  models: Models;                    // the request's models, built from `state`
  server: UpgradeServer;             // the HTTP server, to upgrade the request (`server.upgrade`)
}

// router.handle(req, state, server?): the route's response, undefined once a websocket route upgraded
// the request (handleFetch returns it to Bun as is), null when no route matches. Without a server
// (route tests) no upgrade succeeds.
```

Handlers reach models through `ctx.models` (`models/models.ts`): `ctx.models.sessions`, `ctx.models.nodes`, `ctx.models.broadcast`, `ctx.models.project(projectId)`. The router builds one `Models` per request, so every route and group has it; don't construct `Sessions`, `Nodes`, `ProjectModel` or a broadcast in a route.
