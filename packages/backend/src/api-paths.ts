/**
 * API Path Constants
 *
 * Single source of truth for all REST endpoint paths.
 * Used by route registrations (and could be shared with the frontend).
 */

export const API = {
  health:       "/api/health",
  projects:     "/api/projects",
  project:      "/api/projects/:id",
  sessions:     "/api/projects/:id/sessions",
  session:      "/api/projects/:id/sessions/:sessionId",
  diff:         "/api/projects/:id/diff",
  file:         "/api/projects/:id/file",
  tasks:        "/api/projects/:id/tasks",
  task:         "/api/projects/:id/tasks/:taskId",
  taskSessions: "/api/projects/:id/tasks/:taskId/sessions",
} as const;
