/**
 * The built-in frontend extensions, which app-shell registers in this order, each with an SDK of its own
 * (docs/dev/reins-sdk.md). This is the one place that lists them. An extension with a backend part has its
 * name there (`mcp`).
 */

import type { ExtensionRegistration } from "@reins/sdk";
import { registerFileViewer } from "../components/file-viewer/file-viewer.js";
import { registerCompactCommand } from "./compact-command/compact-command.js";
import { registerMcp } from "./mcp/index.js";
import { registerOpenAiImages } from "./openai-images/index.js";
import { registerFileReferences } from "./message-file-references/message-file-references.js";
import { registerNewSessionCommand } from "./new-session-command/new-session-command.js";
import { registerRecentSessions } from "./recent-sessions/recent-sessions.js";
import { registerProjects } from "./sidebar/projects/projects-section.js";

export const BUILT_IN_EXTENSIONS: readonly ExtensionRegistration[] = [
  // The sidebar's sections, in their default order (the user may change it in Settings → Sidebar).
  { name: "recent-sessions", label: "Recent sessions", description: "The sidebar's Recent section: the sessions with the latest activity, from every project.", register: registerRecentSessions },
  { name: "sidebar-projects", label: "Projects", description: "Every project with its tasks and conversations.", register: registerProjects },
  { name: "file-viewer", label: "File viewer", register: registerFileViewer },
  { name: "file-references", label: "File references", register: registerFileReferences },
  { name: "compact-command", label: "/compact", register: registerCompactCommand },
  { name: "new-session-command", label: "/new", register: registerNewSessionCommand },
  {
    name: "mcp",
    label: "MCP",
    description: "Remote MCP servers, whose tools agents use.",
    register: registerMcp,
  },
  {
    name: "openai-images",
    label: "OpenAI images",
    description: "Image models from OpenAI-compatible image APIs, which agents use through api.images.",
    register: registerOpenAiImages,
  },
];
