/**
 * UI API function definitions.
 *
 * Provides agent-callable functions that trigger frontend UI actions
 * via WebSocket broadcast. For example, `ui.openFile("src/index.ts")`
 * opens the file browser overlay where the calling session is viewed.
 */

import { posix } from "node:path";
import { Type } from "@sinclair/typebox";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";
import { namedNode, optionalNodeParam } from "./nodes.js";

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
      ctx.models.broadcast(params.message);
      return "Broadcast sent";
    },
  }),

  defineFunction({
    name: "ui.openFile",
    description:
      "Open a file in the file browser of the users viewing the calling session, optionally highlighting a line range. " +
      "The file may be on any node (`node`, the calling session's by default). Throws when the file is not there.\n\n" +
      "  await api.ui.openFile(\"src/index.ts\", { startLine: 10, endLine: 20 });\n" +
      "  await api.ui.openFile(\"/home/will/Workspaces/scratch/report.html\", { node: \"Internal\" });",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute, or relative to the calling session's checkout." }),
      options: Type.Optional(Type.Object({
        node: Type.Optional(optionalNodeParam),
        startLine: Type.Optional(Type.Number({ description: "First line to highlight (1-based, inclusive)." })),
        endLine: Type.Optional(Type.Number({ description: "Last line to highlight (1-based, inclusive)." })),
      })),
    }),
    returns: Type.String({ description: "Confirmation message." }),
    async: true,
    tags: ["ui", "file", "open", "browser", "viewer", "display", "show", "node", "remote"],
    execute: async (params, ctx) => {
      if (typeof params.path !== "string" || params.path === "") throw new Error("A path is a non-empty string");
      const { node: nodeName, startLine, endLine } = params.options ?? {};
      const node = namedNode(nodeName ?? "current", ctx);
      const checkout = ctx.session.source;
      const file = posix.resolve(checkout.path, params.path);
      if (!await node.host().hasFile(file, { signal: ctx.signal })) throw new Error(`File not found on ${node.row.name}: ${file}`);
      // The browser shows the source's tree: the caller's checkout when the file is in it, else the
      // file's own directory.
      const fromCheckout = posix.relative(checkout.path, file);
      const inCheckout = node.id === checkout.record.node_id && fromCheckout !== ".." && !fromCheckout.startsWith("../");
      const source = { nodeId: node.id, path: inCheckout ? checkout.path : posix.dirname(file) };
      ctx.models.broadcast({
        type: "open_file",
        sessionId: ctx.session.id,
        projectId: ctx.session.projectId,
        source,
        path: posix.relative(source.path, file),
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
      });
      return "File opened";
    },
  }),
];
