/**
 * API Path Constants
 *
 * Single source of truth for all REST endpoint paths.
 * Used by route registrations (and could be shared with the frontend).
 */

export const API = {
  health:   "/api/health",
  projects: "/api/projects",
  project:  "/api/projects/:id",
  sessions: "/api/sessions",
  tasks:    "/api/tasks",
  palette:  "/api/palette",
} as const;
