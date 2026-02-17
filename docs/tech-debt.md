# Tech Debt

Tracked items for cleanup and improvement. Items are added as they're identified and removed when resolved.

## Frontend

- Several Lit components use manual `querySelector` instead of the idiomatic `@query` decorator (`app.ts`, `chat-panel.ts`, `task-form.ts`)
