export const API = {
  health: "/api/health",
  projects: "/api/projects",
  project: "/api/projects/:id",
  nodes: "/api/nodes",
  sessions: "/api/sessions",
  tasks: "/api/tasks",
  palette: "/api/palette",
  upload: "/api/projects/:id/upload",
  settings: "/api/settings",
  models: "/api/models",
  auth: "/api/auth",
  oauth: "/api/oauth",
  /** The browser's WebSocket. */
  ws: "/ws",
  /** Outside `/api`: what a remote node's machine reaches, the node link and the install script, manifest
   * and bundle (routes/nodes.ts). */
  remoteNodes: "/nodes",
} as const;
