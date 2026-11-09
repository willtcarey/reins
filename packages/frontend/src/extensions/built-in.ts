/**
 * The built-in frontend extensions, which app-shell activates in this order, each with an SDK of its own
 * (docs/dev/reins-sdk.md), unless the user turned one off. This is the one place that lists them. An
 * extension with a backend part has its name there (`mcp`); every name must be in the server's
 * `built-in-names.ts` (its type says so), which records them so they can be turned off. Each has a
 * label and a description for its Settings card; those with only a backend part have them here too
 * (`BUILT_IN_EXTENSION_INFO`).
 */

import type { ExtensionInfo, ExtensionRegistration } from "@reins/sdk";
import type { BuiltInExtensionName } from "@backend/extensions/built-in-names.js";
import { registerFileViewer } from "../components/file-viewer/file-viewer.js";
import { registerCompactCommand } from "./compact-command/compact-command.js";
import { registerMcp } from "./mcp/index.js";
import { registerFileReferences } from "./message-file-references/message-file-references.js";
import { registerNewSessionCommand } from "./new-session-command/new-session-command.js";
import { registerRecentSessions } from "./recent-sessions/recent-sessions.js";
import { registerProjects } from "./sidebar/projects/projects-section.js";
import { registerSecrets } from "./secrets/index.js";

/** A built-in, with the description Settings shows on its card. */
type BuiltIn<T extends ExtensionInfo> = T & { name: BuiltInExtensionName; description: string };

export const BUILT_IN_EXTENSIONS: readonly BuiltIn<ExtensionRegistration>[] = [
  // The sidebar's sections, in their default order (the user may change it in Settings → Sidebar).
  { name: "recent-sessions", label: "Recent sessions", description: "The sidebar's Recent section: the sessions with the latest activity, from every project.", register: registerRecentSessions },
  { name: "sidebar-projects", label: "Projects", description: "Every project with its tasks and conversations.", register: registerProjects },
  { name: "file-viewer", label: "File viewer", description: "Shows a file in the main area or the inspector: its code, or a preview of Markdown, HTML, images and PDFs.", register: registerFileViewer },
  { name: "file-references", label: "File references", description: "Turns file paths in messages into links that open the file, at its lines, in the inspector.", register: registerFileReferences },
  { name: "compact-command", label: "/compact", description: "Summarizes the conversation so far to free its context.", register: registerCompactCommand },
  { name: "new-session-command", label: "/new", description: "Opens a new session here, started with the text after it.", register: registerNewSessionCommand },
  {
    name: "mcp",
    label: "MCP",
    description: "Remote MCP servers, whose tools agents use.",
    register: registerMcp,
  },
  { name: "secrets", label: "Secrets", description: "Agents ask for credentials; you enter them in a masked form, and the agent gets a reference to each, never the value.", register: registerSecrets },
];

/** Built-ins with only a backend part: the server has no label for them, so Settings takes these. */
const BACKEND_ONLY: readonly BuiltIn<ExtensionInfo>[] = [
  { name: "automations", label: "Automations", description: "Sends a session a message when a schedule comes due or a command succeeds." },
  { name: "openai-images", label: "OpenAI images", description: "Image models from OpenAI-compatible images APIs, for agents to make and edit images." },
];

/** What Settings shows of every built-in, whatever parts it has. */
export const BUILT_IN_EXTENSION_INFO: readonly BuiltIn<ExtensionInfo>[] = [...BUILT_IN_EXTENSIONS, ...BACKEND_ONLY];
