# Tech Debt

Tracked items for cleanup and improvement. Items are added as they're identified and removed when resolved.

## Backend

- Widespread `as any` casts (~15 occurrences). Most are for smuggling `projectDir` through `RouteContext` (which doesn't have a typed slot for it) and for SDK type gaps (e.g. `getModel` provider arg, Bun `WebSocket` data). The tsconfig is `strict`, but these casts bypass it at every use site. Should type the route context properly and narrow the remaining casts.

## Frontend

- Several Lit components use manual `querySelector` instead of the idiomatic `@query` decorator (`app.ts`, `chat-panel.ts`, `task-form.ts`)
