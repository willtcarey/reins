# Backend Router & API Routes

## Architecture

The backend uses a lightweight URLPattern-based router (`src/router.ts`) with no external dependencies. Routes are organized by resource in `src/routes/`, composed together in `src/routes/index.ts`.

```
src/
  api-paths.ts          # All route path constants (single source of truth)
  errors.ts             # HttpError class + shorthand throwers
  router.ts             # createRouter(), URLPattern matching, middleware chaining
  routes/
    index.ts            # Composes all routes, defines shared middleware
    health.ts           # GET /api/health
    projects.ts         # CRUD /api/projects
    sessions.ts         # /api/projects/:id/sessions (project-scoped)
    diff.ts             # /api/projects/:id/diff (project-scoped)
```

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
- **Project-scoped routes** (like sessions, diff) are registered inside `router.group(API.project, projectMiddleware, ...)`. The middleware resolves `:id` to a project and attaches `ctx.project` (`ctx.models.project(id)`, a `ProjectModel`) working in the project's default source (404 when the project has none) (how a request picks among several sources comes with multiple-source support).

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

A node the request needed being unreachable (`isNodeUnavailable`: a `RemoteNode` call's `RpcFailure` with code `"unavailable"`) is returned as 503; let it propagate rather than catching it. Other unexpected errors are caught automatically and returned as 500 with the error message.

## Unknown Routes

`handler.ts` tries the router first. An `/api` path (`/api` or under `/api/`) that no route matches, including a known path with another method, is answered `404 {"error": "No API route <METHOD> <path>"}`; only other paths fall back to static files and the web app (`static.ts`, SPA fallback to `index.html`). A client therefore never takes the web app for an API answer; `@reins/client` also treats any non-JSON success where it expects JSON as an error ([ADR-022](../adr/022-shared-api-client-package.md)).

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

// Groups: shared prefix + middleware
router.group("/api/projects/:id", projectMiddleware, (r) => {
  r.get("/sub-resource", handler);
});

// Handler signature:
async (ctx: RouteContext) => Response

// RouteContext:
interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;  // extracted from URLPattern
  state: ServerState;
  models: Models;                    // the request's models, built from `state`
}
```

Handlers reach models through `ctx.models` (`models/models.ts`): `ctx.models.sessions`, `ctx.models.nodes`, `ctx.models.broadcast`, `ctx.models.project(projectId, sourceId?)`. The router builds one `Models` per request, so every route and group has it; don't construct `Sessions`, `Nodes`, `ProjectModel` or a broadcast in a route.
