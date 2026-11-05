/**
 * `ui` (docs/dev/server-sdk.md *UI*): what the browsers show, `reins.ui`, for an extension and an agent's
 * script alike. A file is opened for the users viewing a session: a script's own, or the one an extension names.
 */

import { posix } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ScriptNamespace } from "@reins/sdk/server";
import { namedNode, optionalNodeParam } from "./nodes.js";
import { notForScripts, sdkMethod, signalOf, type CallContext } from "./declaration.js";

const broadcast = sdkMethod({
  description:
    "Broadcast an arbitrary frontend WebSocket message to connected clients. " +
    "Intended for debugging and manually exercising UI event paths.",
  params: [{ name: "message", schema: Type.Any({ description: "ServerMessage-shaped payload to broadcast." }) }],
  returns: Type.String({ description: "Confirmation message." }),
  tags: ["ui", "broadcast", "websocket", "event", "debug"],
  async run(context, message) {
    context.models.broadcast(message);
    return "Broadcast sent";
  },
});

const openFile = sdkMethod({
  description:
    "Open a file in the file browser of the users viewing the calling session, optionally highlighting a line range. " +
    "The file may be on any node (`node`, the calling session's by default). Throws when the file is not there.\n\n" +
    "  await reins.ui.openFile(\"src/index.ts\", { startLine: 10, endLine: 20 });\n" +
    "  await reins.ui.openFile(\"/home/will/Workspaces/scratch/report.html\", { node: \"Internal\" });",
  params: [
    { name: "path", schema: Type.String({ minLength: 1, description: "Absolute, or relative to the session's checkout." }) },
    {
      name: "options",
      schema: Type.Object({
        node: Type.Optional(optionalNodeParam),
        startLine: Type.Optional(Type.Number({ description: "First line to highlight (1-based, inclusive)." })),
        endLine: Type.Optional(Type.Number({ description: "Last line to highlight (1-based, inclusive)." })),
        sessionId: Type.Optional(notForScripts(Type.String({ description: "The session whose viewers see it: an extension's must be given." }))),
      }),
      optional: true,
    },
  ],
  returns: Type.String({ description: "Confirmation message." }),
  tags: ["ui", "file", "open", "browser", "viewer", "display", "show", "node", "remote"],
  async run(context, path, options = {}) {
    const { startLine, endLine } = options;
    const session = context.caller.kind === "session" ? context.caller.session
      : options.sessionId === undefined ? null : context.models.sessions.get(options.sessionId);
    if (!session) throw new Error("ui.openFile opens a file for the users viewing a session: an extension names it (options.sessionId)");
    const node = options.node === undefined ? context.models.nodes.get(session.source.record.node_id) : namedNode(context, options.node);
    const checkout = session.source;
    const file = posix.resolve(checkout.path, path);
    if (!await node.host().hasFile(file, { signal: signalOf(context) })) throw new Error(`File not found on ${node.row.name}: ${file}`);
    // The browser shows the source's tree: the session's checkout when the file is in it, else the file's own
    // directory.
    const fromCheckout = posix.relative(checkout.path, file);
    const inCheckout = node.id === checkout.record.node_id && fromCheckout !== ".." && !fromCheckout.startsWith("../");
    const source = { nodeId: node.id, path: inCheckout ? checkout.path : posix.dirname(file) };
    context.models.broadcast({
      type: "open_file",
      sessionId: session.id,
      projectId: session.projectId,
      source,
      path: posix.relative(source.path, file),
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
    });
    return "File opened";
  },
});

export const UI = { namespace: "ui", methods: { broadcast, openFile } } satisfies ScriptNamespace<CallContext>;
