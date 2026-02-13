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

1. **Add the path constant** to `src/api-paths.ts`:
   ```ts
   export const API = {
     // ...existing paths
     myThing: "/api/projects/:id/my-thing",
   } as const;
   ```

2. **Create a route file** in `src/routes/` (one file per resource):
   ```ts
   // src/routes/my-thing.ts
   import type { RouterGroup, RouteContext } from "../router.js";

   export function registerMyThingRoutes(router: RouterGroup) {
     router.get("/my-thing", async (ctx: RouteContext) => {
       const projectDir = (ctx as any).projectDir as string;
       // ...
       return Response.json({ ok: true });
     });
   }
   ```

3. **Register it** in `src/routes/index.ts`:
   ```ts
   import { registerMyThingRoutes } from "./my-thing.js";

   // Inside buildRouter():
   router.group(API.project, projectMiddleware, (r) => {
     registerSessionRoutes(r);
     registerDiffRoutes(r);
     registerMyThingRoutes(r);  // <-- add here
   });
   ```

## Project-Scoped vs Top-Level Routes

- **Top-level routes** (like `/api/projects`, `/api/health`) are registered directly on the router.
- **Project-scoped routes** (like sessions, diff) are registered inside `router.group(API.project, projectMiddleware, ...)`. The middleware resolves `:id` to a project, validates the directory exists, and attaches `projectDir` to the context.

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

Unexpected errors are caught automatically and returned as 500 with the error message.

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
}
```
