/**
 * The built-in frontend extensions, which app-shell registers in this order, each with an SDK of its own
 * (docs/dev/reins-sdk.md). This is the one place that lists them. An extension with a backend part has its
 * name there (`mcp`).
 */

import type { ExtensionRegistration } from "@reins/sdk";
import { registerFileViewer } from "../components/file-viewer/file-viewer.js";
import { registerCompactCommand } from "./compact-command/compact-command.js";
import { registerMcp } from "./mcp/index.js";
import { registerFileReferences } from "./message-file-references/message-file-references.js";
import { registerNewSessionCommand } from "./new-session-command/new-session-command.js";

export const BUILT_IN_EXTENSIONS: readonly ExtensionRegistration[] = [
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
];
