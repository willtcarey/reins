/**
 * UI API function definitions.
 *
 * Provides agent-callable functions that trigger frontend UI actions
 * via WebSocket broadcast. For example, `ui.openFile("src/index.ts")`
 * opens the file browser overlay on every connected client.
 */

import { Type } from "@sinclair/typebox";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

export const UI_FUNCTIONS: ApiFunctionDef[] = [
  defineFunction({
    name: "ui.broadcast",
    description:
      "Broadcast an arbitrary frontend WebSocket message to connected clients. " +
      "Intended for debugging and manually exercising UI event paths.",
    parameters: Type.Object({
      message: Type.Any({ description: "ServerMessage-shaped payload to broadcast." }),
    }),
    returns: Type.String({ description: "Confirmation message." }),
    tags: ["ui", "broadcast", "websocket", "event", "debug"],
    execute: (params, ctx) => {
      ctx.broadcast(params.message);
      return "Broadcast sent";
    },
  }),

  defineFunction({
    name: "ui.openFile",
    description:
      "Open the file browser overlay to a specific file. " +
      "The path is relative to the project root. " +
      "Optionally specify startLine and endLine to highlight a line range.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the project root." }),
      startLine: Type.Optional(
        Type.Number({ description: "First line to highlight (1-based, inclusive)." }),
      ),
      endLine: Type.Optional(
        Type.Number({ description: "Last line to highlight (1-based, inclusive)." }),
      ),
    }),
    returns: Type.String({ description: "Confirmation message." }),
    async: true,
    tags: ["ui", "file", "open", "browser", "viewer", "display"],
    execute: (params, ctx) => {
      ctx.broadcast({
        type: "open_file",
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
        path: params.path,
        startLine: params.startLine,
        endLine: params.endLine,
      });
      return "File opened";
    },
  }),
];
