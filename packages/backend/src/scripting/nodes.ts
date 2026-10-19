/**
 * Node API function definitions.
 */

import { types } from "node:util";
import { Type } from "@sinclair/typebox";
import { getSource } from "../node-store.js";
import type { NodeModel, NodeView } from "../models/node.js";
import { MAX_NODE_HOST_BYTES } from "../models/node-host.js";
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
    "Get a node (by default, the calling session's) with the projects' sources on it: each source's project and " +
    "its path on the node. Throws for an unknown or removed node.",
  parameters: Type.Object({
    nodeId: Type.Optional(Type.String({ description: "The node; by default, the calling session's node." })),
  }),
  returns: NodeDetailSchema,
  tags: ["nodes", "node", "get", "sources", "checkouts", "paths", "read"],
  execute: (params, ctx) => {
    const nodeId = params.nodeId ?? callerNodeId(ctx);
    if (!nodeId) throw new Error("The calling session has no node");
    const model = ctx.models.nodes.get(nodeId);
    if (model.removed) throw new Error(`Node removed: ${nodeId}`);
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
    "Restart a node on its current code, to load node code you changed (packages/node). Returns as soon as the " +
    "reload is scheduled, before it happens: do not wait for it in the same script. The node holds every run, " +
    "including the calling session's, at its next model request or tool call, restarts once nothing is in flight " +
    "and the runs continue on the new code, so the caller's next request is the first to run on it. Fails at once " +
    "when the node's new code does not build or nothing would restart it. A long tool call elsewhere can hold the " +
    "reload up for up to 60 seconds; then it is cancelled, unless `force` cuts that call off.",
  parameters: Type.Object({
    nodeId: Type.Optional(Type.String({ description: "The node to reload; by default, the calling session's node." })),
    force: Type.Optional(Type.Boolean({ description: "At the 60 second bound, cut off calls still in flight instead of cancelling the reload." })),
  }),
  returns: NodeReloadSchema,
  async: true,
  tags: ["nodes", "node", "reload", "restart", "code", "deploy", "hot reload"],
  execute: async (params, ctx) => {
    const nodeId = params.nodeId ?? getSource(ctx.sourceId)?.node_id;
    if (!nodeId) throw new Error("The calling session has no node");
    return { nodeId, ...await ctx.models.nodes.get(nodeId).reload({ force: params.force ?? false }) };
  },
});

/** The longest a command run from a script may take: a script's own bound. */
export const MAX_RUN_TIMEOUT_MS = 30_000;
const MIB = 1024 * 1024;

const nodeParam = Type.String({ description: 'The node: its ID, its name (any case), or "current" for the calling session\'s node.' });

/** The node a script names (ID, name or "current"). */
function namedNode(node: unknown, ctx: ApiContext): NodeModel {
  if (typeof node !== "string" || node.trim() === "") throw new Error("A node is named by its ID, its name, or \"current\"");
  if (node === "current") {
    const nodeId = callerNodeId(ctx);
    if (!nodeId) throw new Error("The calling session has no node");
    return ctx.models.nodes.get(nodeId);
  }
  return ctx.models.nodes.find(node);
}

function pathParam(path: unknown): string {
  if (typeof path !== "string" || path === "") throw new Error("A path is a non-empty string");
  return path;
}

export const NodeRunResultSchema = Type.Object({
  exitCode: Type.Number({ description: "The command's exit code (128 + the signal's number when a signal killed it)." }),
  output: Type.String({ description: `Its stdout and stderr together, as text: at most the first ${MAX_NODE_HOST_BYTES / MIB} MiB.` }),
  truncated: Type.Boolean({ description: `Whether it wrote more than the ${MAX_NODE_HOST_BYTES / MIB} MiB \`output\` holds.` }),
});

const nodeAccessNotes =
  "Works on any connected node, on any path there: not confined to a project or checkout. `~` is that node's " +
  "home, and relative paths start in it. A node that is not connected fails at once (\"Node unavailable\"), an " +
  "unknown one too (\"Node not found\"); nothing waits for it. What a script holds never reaches your context " +
  "unless the script returns it, so read, transform and copy content inside the script and return only what you need.";

export const nodesReadFileFunction = defineFunction({
  name: "nodes.readFile",
  description:
    `Read a whole file on a node: text (UTF-8) by default, its bytes (a Uint8Array) with \`{ binary: true }\`. ` +
    `Not the \`read\` tool: no line limits or notes. A file over ${MAX_NODE_HOST_BYTES / MIB} MiB fails. ${nodeAccessNotes}\n\n` +
    "Copy an image from one node to this session's node:\n" +
    "  const bytes = await api.nodes.readFile(\"Mac mini\", \"~/Pictures/diagram.png\", { binary: true });\n" +
    "  await api.nodes.writeFile(\"current\", \"~/Downloads/diagram.png\", bytes);\n" +
    "  return bytes.length;\n\n" +
    "Read a note and return only a summary of it:\n" +
    "  const note = await api.nodes.readFile(\"Mac mini\", \"~/Obsidian/Notes/Plans.md\");\n" +
    "  return { headings: note.split(\"\\n\").filter(line => line.startsWith(\"#\")), characters: note.length };",
  parameters: Type.Object({
    node: nodeParam,
    path: Type.String({ description: "The file's path on the node: absolute, `~/…`, or relative to the node's home." }),
    options: Type.Optional(Type.Object({
      binary: Type.Optional(Type.Boolean({ description: "Return the bytes (a Uint8Array) instead of text." })),
    })),
  }),
  returns: Type.Union([Type.String(), Type.Uint8Array()]),
  async: true,
  tags: ["nodes", "node", "files", "file", "read", "cat", "copy", "binary", "bytes", "note", "machine", "remote"],
  execute: async (params, ctx) => {
    const bytes = await namedNode(params.node, ctx).host().readFile(pathParam(params.path), { signal: ctx.signal });
    return params.options?.binary ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  },
});

export const nodesWriteFileFunction = defineFunction({
  name: "nodes.writeFile",
  description:
    "Write a whole file on a node, from text (written as UTF-8) or bytes (a Uint8Array, such as nodes.readFile " +
    `returns with \`{ binary: true }\`), as the \`write\` tool does: its directories are created and a file there is replaced. ${nodeAccessNotes}\n\n` +
    "Copy a file between nodes without its content entering your context:\n" +
    "  const bytes = await api.nodes.readFile(\"build-box\", \"/srv/out/report.pdf\", { binary: true });\n" +
    "  await api.nodes.writeFile(\"Mac mini\", \"~/Documents/report.pdf\", bytes);",
  parameters: Type.Object({
    node: nodeParam,
    path: Type.String({ description: "The file's path on the node: absolute, `~/…`, or relative to the node's home." }),
    content: Type.Union([Type.String(), Type.Uint8Array()], { description: "Text, or bytes." }),
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

export const nodesRunFunction = defineFunction({
  name: "nodes.run",
  description:
    "Run a short bash command on a node, as the bash tool runs commands there, starting in the node's home " +
    `unless \`cwd\` is given. Returns its exit code (a failing command does not throw) and its output, the first ` +
    `${MAX_NODE_HOST_BYTES / MIB} MiB of it (\`truncated\` when there was more). It is killed, and the call fails, ` +
    `after \`timeoutMs\` (at most and by default ${MAX_RUN_TIMEOUT_MS / 1000} seconds): for longer work, start a session. ${nodeAccessNotes}\n\n` +
    "  const { exitCode, output } = await api.nodes.run(\"Mac mini\", \"df -h ~ && uptime\");\n" +
    "  return exitCode === 0 ? output : `failed (${exitCode}): ${output}`;",
  parameters: Type.Object({
    node: nodeParam,
    command: Type.String({ description: "The bash command." }),
    options: Type.Optional(Type.Object({
      cwd: Type.Optional(Type.String({ description: "Where it starts: absolute, `~/…`, or relative to the node's home (the default)." })),
      timeoutMs: Type.Optional(Type.Number({ description: `Kill it after this many milliseconds (1 to ${MAX_RUN_TIMEOUT_MS}, the default).` })),
    })),
  }),
  returns: NodeRunResultSchema,
  async: true,
  tags: ["nodes", "node", "run", "exec", "command", "shell", "bash", "machine", "remote"],
  execute: async (params, ctx) => {
    if (typeof params.command !== "string" || params.command.trim() === "") throw new Error("A command is a non-empty string");
    const timeoutMs = params.options?.timeoutMs ?? MAX_RUN_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RUN_TIMEOUT_MS) throw new Error(`timeoutMs must be from 1 to ${MAX_RUN_TIMEOUT_MS}`);
    return namedNode(params.node, ctx).host().run(params.command, { cwd: params.options?.cwd, timeoutMs, signal: ctx.signal });
  },
});

export const NODE_FUNCTIONS: ApiFunctionDef[] = [
  nodesListFunction, nodesGetFunction, nodesReloadFunction, nodesReadFileFunction, nodesWriteFileFunction, nodesRunFunction,
];
