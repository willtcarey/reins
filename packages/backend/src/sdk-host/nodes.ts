/**
 * `nodes` (docs/dev/server-sdk.md *Nodes*): the machines sessions work on, and files and commands on any of them,
 * for an extension (`reins.nodes`) and an agent's script (`api.nodes`), over the `Nodes` model and its `NodeHost`.
 * A node is named by its ID or its name; a script may say `"current"`, its session's node, which is also the
 * default where a node may be left out. An extension has no session, so it names the node. What is read and run is
 * held in the server's memory, so it is bounded.
 */

import { types } from "node:util";
import { Type } from "@sinclair/typebox";
import type { ScriptNamespace } from "@reins/sdk/server";
import type { NodeModel, NodeView } from "../models/node.js";
import { FileTooLargeError } from "../models/node-host.js";
import { SignalSchema, sdkMethod, signalOf, type CallContext } from "./declaration.js";

/** A script's own bound: an agent waits for it. */
export const MAX_SCRIPT_RUN_TIMEOUT_MS = 30_000;
/** Longer than a script's: an extension's service waits for it without holding up an agent. */
export const MAX_EXTENSION_RUN_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** What a call may hold: it is held in the server's memory. */
export const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** A location sessions work in: a node and an absolute path there. */
export const LocationSchema = Type.Object({
  nodeId: Type.String({ minLength: 1, description: "The node's ID." }),
  path: Type.String({ minLength: 1, description: "An absolute path on the node." }),
});

export const ProjectRefSchema = Type.Object({ id: Type.Number(), name: Type.String() });

export const NodeSourceSchema = Type.Object({
  sourceId: Type.Number(),
  path: Type.String({ description: "The source's absolute path on the node." }),
  projects: Type.Array(ProjectRefSchema, { description: "The projects whose sessions work there, or whose default source it is." }),
});

const nodeFields = {
  id: Type.String(),
  name: Type.String(),
  hostname: Type.Union([Type.String(), Type.Null()], { description: "The machine's hostname, as it said when it paired; null for a node never paired (the local one)." }),
  connected: Type.Boolean({ description: "Whether the node is connected now." }),
  revoked: Type.Boolean({ description: "Whether the node was revoked: it may not connect." }),
  current: Type.Boolean({ description: "Whether the calling session runs its tools on this node (never, for an extension)." }),
  sourceCount: Type.Number({ description: "How many sources (directories sessions work in) are in use on the node; nodes.get lists them." }),
};

export const NodeSchema = Type.Object(nodeFields);

export const NodeDetailSchema = Type.Object({
  ...nodeFields,
  sources: Type.Array(NodeSourceSchema, { description: "The sources (locations: directories sessions work in) in use on the node, by path." }),
});

export const NodeReloadSchema = Type.Object({
  nodeId: Type.String({ description: "The node being reloaded." }),
  scheduled: Type.Literal(true, { description: "The reload is scheduled; it has not happened yet." }),
});

export const NodeRunResultSchema = Type.Object({
  exitCode: Type.Number({ description: "The command's exit code (128 + the signal's number when a signal killed it)." }),
  output: Type.String({ description: `stdout and stderr together, as text: the first ${MAX_SCRIPT_BYTES / MIB} MiB.` }),
  truncated: Type.Boolean({ description: "Whether there was more output than `output` holds." }),
});

export const NodeCopyResultSchema = Type.Object({
  bytes: Type.Number({ description: "The file's size: the bytes copied." }),
});

const nodeParam = Type.String({ description: 'Its ID, its name (any case), or "current" for the calling session\'s.' });
export const optionalNodeParam = Type.String({ description: 'Its ID, its name (any case), or "current": the calling session\'s, the default.' });
const pathParam = Type.String({ minLength: 1, description: "Absolute, `~/…`, or relative to the node's home." });
const SignalOptionsSchema = Type.Object({ signal: Type.Optional(SignalSchema) });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The calling session's node, or null for an extension. */
const callerNodeId = (context: CallContext) => context.caller.kind === "session" ? context.caller.session.source.record.node_id : null;

/** The node named by its ID, its name (any case), or "current" (the calling session's). */
export function namedNode(context: CallContext, node: string): NodeModel {
  if (typeof node !== "string" || node.trim() === "") throw new Error("A node is named by its ID, its name, or \"current\"");
  if (node !== "current") return context.models.nodes.find(node);
  const nodeId = callerNodeId(context);
  if (nodeId === null) throw new Error("\"current\" names the calling session's node, and an extension has none: name the node");
  return context.models.nodes.get(nodeId);
}

const nodeSummary = (context: CallContext, node: NodeView) => ({
  id: node.id,
  name: node.name,
  hostname: node.hostname,
  connected: node.connected,
  revoked: node.revokedAt !== null,
  current: node.id === callerNodeId(context),
  sourceCount: node.sources.length,
});

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const list = sdkMethod({
  description:
    "List the nodes (machines that run sessions' tools: files and commands), in name order: whether each is " +
    "connected, whether it is the calling session's, and how many sources (directories sessions work in) are in use on it (nodes.get lists them). " +
    "Removed nodes are not listed.",
  params: [],
  returns: Type.Array(NodeSchema),
  tags: ["nodes", "node", "list", "machines", "hosts", "read"],
  run: async context => context.models.nodes.list().map(node => nodeSummary(context, node)),
});

const get = sdkMethod({
  description:
    "Get a node with the sources in use on it (directories sessions work in): each one's path on the node and the " +
    "projects whose sessions work there or whose default source it is. Throws for an unknown or removed node.",
  params: [{ name: "node", schema: optionalNodeParam, optional: true }],
  returns: NodeDetailSchema,
  tags: ["nodes", "node", "get", "sources", "checkouts", "paths", "read"],
  async run(context, node = "current") {
    const model = namedNode(context, node);
    if (model.removed) throw new Error(`Node removed: ${model.id}`);
    const view = model.view();
    return { ...nodeSummary(context, view), sources: view.sources.map(source => ({ sourceId: source.id, path: source.path, projects: source.projects })) };
  },
});

const reload = sdkMethod({
  description:
    "Restart a node on its current code, to load node code you changed (packages/node). Returns once the reload is " +
    "scheduled, before it happens; your next tool call runs on the new code. Fails at once when the new code does " +
    "not build or nothing would restart the node. Waits up to 60 seconds for calls in flight, then gives up.",
  params: [
    { name: "node", schema: optionalNodeParam, optional: true },
    { name: "force", schema: Type.Boolean({ description: "After 60 seconds, cut off calls still in flight instead of giving up." }), optional: true },
  ],
  returns: NodeReloadSchema,
  tags: ["nodes", "node", "reload", "restart", "code", "deploy", "hot reload"],
  async run(context, node = "current", force = false) {
    const model = namedNode(context, node);
    return { nodeId: model.id, ...await model.reload({ force }) };
  },
});

const readFile = sdkMethod({
  description:
    "Read a whole file on a node: as text (UTF-8), or as a Uint8Array with `{ binary: true }`. To copy a file, " +
    "use nodes.copy.\n\n" +
    "Read a note and return only a summary of it:\n" +
    "  const note = await api.nodes.readFile(\"Mac mini\", \"~/Obsidian/Notes/Plans.md\");\n" +
    "  return { headings: note.split(\"\\n\").filter(line => line.startsWith(\"#\")), characters: note.length };",
  params: [
    { name: "node", schema: nodeParam },
    { name: "path", schema: pathParam },
    {
      name: "options",
      schema: Type.Object({
        binary: Type.Optional(Type.Boolean({ description: "Return the bytes (a Uint8Array) instead of text." })),
        signal: Type.Optional(SignalSchema),
      }),
      optional: true,
    },
  ],
  returns: Type.Union([Type.String(), Type.Uint8Array()]),
  tags: ["nodes", "node", "files", "file", "read", "cat", "copy", "binary", "bytes", "note", "machine", "remote"],
  async run(context, node, path, options = {}) {
    let bytes: Uint8Array;
    try {
      bytes = await namedNode(context, node).host().readFile(path, { maxBytes: MAX_SCRIPT_BYTES, signal: signalOf(context, options.signal) });
    } catch (error) {
      // An agent copying with readFile and writeFile learns here that nodes.copy copies it.
      if (!(error instanceof FileTooLargeError)) throw error;
      throw new Error(`Cannot read ${error.path} on "${error.node.name}": it has ${error.size} bytes, more than a script may hold (${MAX_SCRIPT_BYTES / MIB} MiB). ` +
        `To copy it, use api.nodes.copy(${JSON.stringify(node)}, ${JSON.stringify(error.path)}, toNode, toPath): it copies a file of any size.`, { cause: error });
    }
    return options.binary ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  },
});

const writeFile = sdkMethod({
  description:
    "Write a whole file on a node, creating its directories and replacing any file there. To copy a file, use " +
    "nodes.copy.\n\n" +
    "  const { output } = await api.nodes.run(\"build-box\", \"git log --oneline -20\", { cwd: \"/srv/app\" });\n" +
    "  await api.nodes.writeFile(\"current\", \"~/notes/build-box-log.txt\", output);",
  params: [
    { name: "node", schema: nodeParam },
    { name: "path", schema: pathParam },
    { name: "content", schema: Type.Union([Type.String(), Type.Uint8Array()], { description: "Text (written as UTF-8) or bytes." }) },
    { name: "options", schema: SignalOptionsSchema, optional: true },
  ],
  returns: Type.Void(),
  tags: ["nodes", "node", "files", "file", "write", "save", "copy", "binary", "bytes", "machine", "remote"],
  async run(context, node, path, content, options = {}) {
    if (typeof content !== "string" && !types.isUint8Array(content)) throw new Error("A file's content is text or a Uint8Array");
    await namedNode(context, node).host().writeFile(path, content, { signal: signalOf(context, options.signal) });
  },
});

const copy = sdkMethod({
  description:
    "Copy a file of any size between nodes, or within one, without it passing through the script. Creates the " +
    "destination's directories; a file already there is replaced only once the whole file has arrived.\n\n" +
    "  await api.nodes.copy(\"Mac mini\", \"~/Movies/demo.mov\", \"current\", \"~/Downloads/demo.mov\");",
  params: [
    { name: "fromNode", schema: nodeParam },
    { name: "fromPath", schema: pathParam },
    { name: "toNode", schema: nodeParam },
    { name: "toPath", schema: pathParam },
    { name: "options", schema: SignalOptionsSchema, optional: true },
  ],
  returns: NodeCopyResultSchema,
  tags: ["nodes", "node", "files", "file", "copy", "transfer", "move", "send", "download", "upload", "large", "binary", "machine", "remote"],
  async run(context, fromNode, fromPath, toNode, toPath, options = {}) {
    const from = namedNode(context, fromNode).host();
    const to = namedNode(context, toNode).host();
    return from.copyTo(fromPath, to, toPath, { signal: signalOf(context, options.signal) });
  },
});

const run = sdkMethod({
  description:
    "Run a bash command on a node. A failing command returns its exit code rather than throwing; one still " +
    "running after `timeoutMs` is killed and the call fails. For longer work, start a session.\n\n" +
    "  const { exitCode, output } = await api.nodes.run(\"Mac mini\", \"df -h ~ && uptime\");\n" +
    "  return exitCode === 0 ? output : `failed (${exitCode}): ${output}`;",
  params: [
    { name: "node", schema: nodeParam },
    { name: "command", schema: Type.String({ description: "The bash command." }) },
    {
      name: "options",
      schema: Type.Object({
        cwd: Type.Optional(Type.String({ description: "Where it starts: absolute, `~/…`, or relative to the node's home (the default)." })),
        timeoutMs: Type.Optional(Type.Number({ description: `1 to ${MAX_SCRIPT_RUN_TIMEOUT_MS} (the default; an extension's: to ${MAX_EXTENSION_RUN_TIMEOUT_MS}).` })),
        signal: Type.Optional(SignalSchema),
      }),
      optional: true,
    },
  ],
  returns: NodeRunResultSchema,
  tags: ["nodes", "node", "run", "exec", "command", "shell", "bash", "machine", "remote"],
  async run(context, node, command, options = {}) {
    if (typeof command !== "string" || !command.trim()) throw new Error("A command must not be blank");
    const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const max = context.caller.kind === "extension" ? MAX_EXTENSION_RUN_TIMEOUT_MS : MAX_SCRIPT_RUN_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > max) throw new Error(`timeoutMs must be from 1 to ${max}`);
    return namedNode(context, node).host().run(command, { ...(cwd === undefined ? {} : { cwd }), timeoutMs, maxBytes: MAX_SCRIPT_BYTES, signal: signalOf(context, options.signal) });
  },
});

export const NODES = {
  namespace: "nodes",
  methods: { list, get, reload, readFile, writeFile, copy, run },
  types: {
    Node: NodeSchema,
    NodeDetail: NodeDetailSchema,
    NodeSource: NodeSourceSchema,
    ProjectRef: ProjectRefSchema,
    Location: LocationSchema,
    NodeReload: NodeReloadSchema,
    NodeRunResult: NodeRunResultSchema,
    NodeCopyResult: NodeCopyResultSchema,
  },
} satisfies ScriptNamespace<CallContext>;
