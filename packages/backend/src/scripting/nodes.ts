/**
 * Node API function definitions.
 */

import { types } from "node:util";
import { Type } from "@sinclair/typebox";
import { getSource } from "../node-store.js";
import type { NodeModel, NodeView } from "../models/node.js";
import { FileTooLargeError } from "../models/node-host.js";
import { type ApiContext, type ApiFunctionDef, defineFunction } from "./define-function.js";

export const NodeSourceSchema = Type.Object({
  sourceId: Type.Number(),
  projectId: Type.Number(),
  projectName: Type.String(),
  path: Type.String({ description: "The source's absolute path on the node." }),
});

const nodeFields = {
  id: Type.String(),
  name: Type.String(),
  hostname: Type.Union([Type.String(), Type.Null()], { description: "The machine's hostname, as it said when it paired; null for a node never paired (the local one)." }),
  connected: Type.Boolean({ description: "Whether the node is connected now." }),
  revoked: Type.Boolean({ description: "Whether the node was revoked: it may not connect." }),
  current: Type.Boolean({ description: "Whether the calling session runs its tools on this node." }),
  sourceCount: Type.Number({ description: "How many projects' sources (checkouts) are on the node; nodes.get lists them." }),
};

export const NodeSchema = Type.Object(nodeFields);

export const NodeDetailSchema = Type.Object({
  ...nodeFields,
  sources: Type.Array(NodeSourceSchema, { description: "The projects' sources (checkouts) on the node, by path." }),
});

/** The calling session's node. */
const callerNodeId = (ctx: ApiContext) => getSource(ctx.sourceId)?.node_id;

const nodeParam = Type.String({ description: 'Its ID, its name (any case), or "current" for the calling session\'s.' });
const optionalNodeParam = Type.String({ description: 'Its ID, its name (any case), or "current": the calling session\'s, the default.' });

function namedNode(node: unknown, ctx: ApiContext): NodeModel {
  if (typeof node !== "string" || node.trim() === "") throw new Error("A node is named by its ID, its name, or \"current\"");
  if (node === "current") {
    const nodeId = callerNodeId(ctx);
    if (!nodeId) throw new Error("The calling session has no node");
    return ctx.models.nodes.get(nodeId);
  }
  return ctx.models.nodes.find(node);
}

const nodeSummary = (node: NodeView, ctx: ApiContext) => ({
  id: node.id,
  name: node.name,
  hostname: node.hostname,
  connected: node.connected,
  revoked: node.revokedAt !== null,
  current: node.id === callerNodeId(ctx),
  sourceCount: node.sources.length,
});

export const nodesListFunction = defineFunction({
  name: "nodes.list",
  description:
    "List the nodes (machines that run sessions' tools: files and commands), in name order: whether each is " +
    "connected, whether it is the calling session's, and how many sources it holds (nodes.get lists them). " +
    "Removed nodes are not listed.",
  parameters: Type.Object({}),
  returns: Type.Array(NodeSchema),
  tags: ["nodes", "node", "list", "machines", "hosts", "read"],
  execute: (_params, ctx) => ctx.models.nodes.list().map(node => nodeSummary(node, ctx)),
});

export const nodesGetFunction = defineFunction({
  name: "nodes.get",
  description:
    "Get a node with the projects' sources on it: each source's project and its path on the node. Throws for an " +
    "unknown or removed node.",
  parameters: Type.Object({
    node: Type.Optional(optionalNodeParam),
  }),
  returns: NodeDetailSchema,
  tags: ["nodes", "node", "get", "sources", "checkouts", "paths", "read"],
  execute: (params, ctx) => {
    const model = namedNode(params.node ?? "current", ctx);
    if (model.removed) throw new Error(`Node removed: ${model.id}`);
    const node = model.view();
    return {
      ...nodeSummary(node, ctx),
      sources: node.sources.map(source => ({ sourceId: source.project.sourceId, projectId: source.project.id, projectName: source.project.name, path: source.path })),
    };
  },
});

export const NodeReloadSchema = Type.Object({
  nodeId: Type.String({ description: "The node being reloaded." }),
  scheduled: Type.Literal(true, { description: "The reload is scheduled; it has not happened yet." }),
});

export const nodesReloadFunction = defineFunction({
  name: "nodes.reload",
  description:
    "Restart a node on its current code, to load node code you changed (packages/node). Returns once the reload is " +
    "scheduled, before it happens; your next tool call runs on the new code. Fails at once when the new code does " +
    "not build or nothing would restart the node. Waits up to 60 seconds for calls in flight, then gives up.",
  parameters: Type.Object({
    node: Type.Optional(optionalNodeParam),
    force: Type.Optional(Type.Boolean({ description: "After 60 seconds, cut off calls still in flight instead of giving up." })),
  }),
  returns: NodeReloadSchema,
  async: true,
  tags: ["nodes", "node", "reload", "restart", "code", "deploy", "hot reload"],
  execute: async (params, ctx) => {
    const model = namedNode(params.node ?? "current", ctx);
    return { nodeId: model.id, ...await model.reload({ force: params.force ?? false }) };
  },
});

/** A script's own bound. */
export const MAX_RUN_TIMEOUT_MS = 30_000;
/** A script runs in the server's process (`tools/execute.ts`), so what it holds is the server's memory. */
export const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
const MIB = 1024 * 1024;

function pathParam(path: unknown): string {
  if (typeof path !== "string" || path === "") throw new Error("A path is a non-empty string");
  return path;
}

export const NodeRunResultSchema = Type.Object({
  exitCode: Type.Number({ description: "The command's exit code (128 + the signal's number when a signal killed it)." }),
  output: Type.String({ description: `stdout and stderr together, as text: the first ${MAX_SCRIPT_BYTES / MIB} MiB.` }),
  truncated: Type.Boolean({ description: "Whether there was more output than `output` holds." }),
});

const pathParamSchema = Type.String({ description: "Absolute, `~/…`, or relative to the node's home." });

export const nodesReadFileFunction = defineFunction({
  name: "nodes.readFile",
  description:
    "Read a whole file on a node: as text (UTF-8), or as a Uint8Array with `{ binary: true }`. To copy a file, " +
    "use nodes.copy.\n\n" +
    "Read a note and return only a summary of it:\n" +
    "  const note = await api.nodes.readFile(\"Mac mini\", \"~/Obsidian/Notes/Plans.md\");\n" +
    "  return { headings: note.split(\"\\n\").filter(line => line.startsWith(\"#\")), characters: note.length };",
  parameters: Type.Object({
    node: nodeParam,
    path: pathParamSchema,
    options: Type.Optional(Type.Object({
      binary: Type.Optional(Type.Boolean({ description: "Return the bytes (a Uint8Array) instead of text." })),
    })),
  }),
  returns: Type.Union([Type.String(), Type.Uint8Array()]),
  async: true,
  tags: ["nodes", "node", "files", "file", "read", "cat", "copy", "binary", "bytes", "note", "machine", "remote"],
  execute: async (params, ctx) => {
    let bytes: Uint8Array;
    try {
      bytes = await namedNode(params.node, ctx).host().readFile(pathParam(params.path), { maxBytes: MAX_SCRIPT_BYTES, signal: ctx.signal });
    } catch (error) {
      // An agent copying with readFile and writeFile learns here that nodes.copy copies it.
      if (!(error instanceof FileTooLargeError)) throw error;
      throw new Error(`Cannot read ${error.path} on "${error.node.name}": it has ${error.size} bytes, more than a script may hold (${MAX_SCRIPT_BYTES / MIB} MiB). ` +
        `To copy it, use api.nodes.copy(${JSON.stringify(params.node)}, ${JSON.stringify(error.path)}, toNode, toPath): it copies a file of any size.`, { cause: error });
    }
    return params.options?.binary ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  },
});

export const nodesWriteFileFunction = defineFunction({
  name: "nodes.writeFile",
  description:
    "Write a whole file on a node, creating its directories and replacing any file there. To copy a file, use " +
    "nodes.copy.\n\n" +
    "  const { output } = await api.nodes.run(\"build-box\", \"git log --oneline -20\", { cwd: \"/srv/app\" });\n" +
    "  await api.nodes.writeFile(\"current\", \"~/notes/build-box-log.txt\", output);",
  parameters: Type.Object({
    node: nodeParam,
    path: pathParamSchema,
    content: Type.Union([Type.String(), Type.Uint8Array()], { description: "Text (written as UTF-8) or bytes." }),
  }),
  returns: Type.Void(),
  async: true,
  tags: ["nodes", "node", "files", "file", "write", "save", "copy", "binary", "bytes", "machine", "remote"],
  execute: async (params, ctx) => {
    const content: unknown = params.content;
    if (typeof content !== "string" && !types.isUint8Array(content)) throw new Error("A file's content is text or a Uint8Array");
    await namedNode(params.node, ctx).host().writeFile(pathParam(params.path), content, { signal: ctx.signal });
  },
});

export const NodeCopyResultSchema = Type.Object({
  bytes: Type.Number({ description: "The file's size: the bytes copied." }),
});

export const nodesCopyFunction = defineFunction({
  name: "nodes.copy",
  description:
    "Copy a file of any size between nodes, or within one, without it passing through the script. Creates the " +
    "destination's directories; a file already there is replaced only once the whole file has arrived.\n\n" +
    "  await api.nodes.copy(\"Mac mini\", \"~/Movies/demo.mov\", \"current\", \"~/Downloads/demo.mov\");",
  parameters: Type.Object({
    fromNode: nodeParam,
    fromPath: pathParamSchema,
    toNode: nodeParam,
    toPath: pathParamSchema,
  }),
  returns: NodeCopyResultSchema,
  async: true,
  tags: ["nodes", "node", "files", "file", "copy", "transfer", "move", "send", "download", "upload", "large", "binary", "machine", "remote"],
  execute: async (params, ctx) => {
    const from = namedNode(params.fromNode, ctx).host();
    const to = namedNode(params.toNode, ctx).host();
    return from.copyTo(pathParam(params.fromPath), to, pathParam(params.toPath), { signal: ctx.signal });
  },
});

export const nodesRunFunction = defineFunction({
  name: "nodes.run",
  description:
    "Run a bash command on a node. A failing command returns its exit code rather than throwing; one still " +
    "running after `timeoutMs` is killed and the call fails. For longer work, start a session.\n\n" +
    "  const { exitCode, output } = await api.nodes.run(\"Mac mini\", \"df -h ~ && uptime\");\n" +
    "  return exitCode === 0 ? output : `failed (${exitCode}): ${output}`;",
  parameters: Type.Object({
    node: nodeParam,
    command: Type.String({ description: "The bash command." }),
    options: Type.Optional(Type.Object({
      cwd: Type.Optional(Type.String({ description: "Where it starts: absolute, `~/…`, or relative to the node's home (the default)." })),
      timeoutMs: Type.Optional(Type.Number({ description: `1 to ${MAX_RUN_TIMEOUT_MS} (the default).` })),
    })),
  }),
  returns: NodeRunResultSchema,
  async: true,
  tags: ["nodes", "node", "run", "exec", "command", "shell", "bash", "machine", "remote"],
  execute: async (params, ctx) => {
    if (typeof params.command !== "string" || params.command.trim() === "") throw new Error("A command is a non-empty string");
    const timeoutMs = params.options?.timeoutMs ?? MAX_RUN_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RUN_TIMEOUT_MS) throw new Error(`timeoutMs must be from 1 to ${MAX_RUN_TIMEOUT_MS}`);
    return namedNode(params.node, ctx).host().run(params.command, { cwd: params.options?.cwd, timeoutMs, maxBytes: MAX_SCRIPT_BYTES, signal: ctx.signal });
  },
});

export const NODE_FUNCTIONS: ApiFunctionDef[] = [
  nodesListFunction, nodesGetFunction, nodesReloadFunction, nodesReadFileFunction, nodesWriteFileFunction, nodesCopyFunction, nodesRunFunction,
];
