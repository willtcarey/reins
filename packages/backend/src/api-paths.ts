export const API = {
  health: "/api/health",
  projects: "/api/projects",
  project: "/api/projects/:id",
  sessions: "/api/sessions",
  tasks: "/api/tasks",
  palette: "/api/palette",
  upload: "/api/projects/:id/upload",
  settings: "/api/settings",
  models: "/api/models",
  auth: "/api/auth",
  oauth: "/api/oauth",
} as const;
