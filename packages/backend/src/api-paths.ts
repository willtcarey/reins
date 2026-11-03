export const API = {
  health: "/api/health",
  projects: "/api/projects",
  project: "/api/projects/:id",
  nodes: "/api/nodes",
  sessions: "/api/sessions",
  tasks: "/api/tasks",
  palette: "/api/palette",
  settings: "/api/settings",
  models: "/api/models",
  auth: "/api/auth",
  oauth: "/api/oauth",
  /** Each extension's HTTP API, under its name (routes/extensions.ts). */
  extensionsApi: "/api/extensions",
  /** Outside `/api`: each extension's pages for the browser, under its name (routes/extensions.ts). */
  extensionPages: "/extensions",
  /** The browser's WebSocket. */
  ws: "/ws",
  /** Outside `/api`: what a remote node's machine reaches, the node link and the install script, manifest
   * and bundle (routes/nodes.ts). */
  remoteNodes: "/nodes",
} as const;
