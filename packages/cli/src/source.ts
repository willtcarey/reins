/**
 * `reins source add <path> --project <id> [--node <nodeId>]` and `reins source list [--project <id>]
 * [--node <nodeId>]`: projects' sources (their working copies on nodes), managed on a Reins server (`POST
 * /api/projects/:id/sources`, `GET /api/nodes`; which server: server.ts). The server's sources are the only
 * record of them: a node keeps none and works in the path it is sent (ADR-026). Without `--node`, add
 * means this machine's node (server.ts), and a relative path is resolved here.
 */
import { isAbsolute, resolve } from "node:path";
import { defineCommand, EXIT_OK, UsageError, type OptionSpecs } from "./command.js";
import { requestFailure, resolveServer, serverOptions } from "./server.js";

const nodeOption = {
  node: { type: "string", value: "nodeId", description: "The node the source is on (default: this machine's)" },
} satisfies OptionSpecs;

/** A `--project` value: a project ID. */
function projectId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError("--project takes a project ID.");
  return Number(value);
}

/** Exit 0 added, 1 the server's refusal (not a directory on the node, a path another project's source has, a
 * second source of the project on the node, an offline node), 2 usage, 5 no server answering. */
export const sourceAddCommand = defineCommand({
  words: ["source", "add"],
  args: ["path"],
  options: {
    project: { type: "string", value: "id", description: "The project the source belongs to (required)" },
    ...nodeOption,
    ...serverOptions,
  },
  summary: "Add a source of a project: a directory on a node, which the node checks",
  async run({ args: [path], options }, { env, out, err }) {
    const project = projectId(options.project);
    if (project === undefined) throw new UsageError("Name the project: --project <id>.");
    // A path on another machine cannot be resolved here.
    if (options.node !== undefined && !isAbsolute(path)) throw new UsageError("A source on a node named with --node needs an absolute path.");
    const { serverUrl, nodeId, client } = await resolveServer(options, env, options.node);
    const sourcePath = resolve(path);
    try {
      await client.projects.addSource(project, { nodeId, path: sourcePath });
    } catch (error) {
      const failure = requestFailure(error, serverUrl);
      err(`Not added: ${failure.message}`);
      return failure.exitCode;
    }
    out(`Source added to project ${project} on node ${nodeId}: ${sourcePath}`);
    return EXIT_OK;
  },
});

/** One line per source: its node, path and project. Exit 0, 1 the server's refusal, 2 usage, 5 no server
 * answering. */
export const sourceListCommand = defineCommand({
  words: ["source", "list"],
  args: [],
  options: {
    project: { type: "string", value: "id", description: "Only that project's sources" },
    node: { type: "string", value: "nodeId", description: "Only the sources on that node" },
    ...serverOptions,
  },
  summary: "List the sources of projects on nodes",
  async run({ options }, { env, out, err }) {
    const project = projectId(options.project);
    const { serverUrl, client } = await resolveServer(options, env);
    let nodes;
    try {
      nodes = await client.nodes.list();
    } catch (error) {
      const failure = requestFailure(error, serverUrl);
      err(`No sources listed: ${failure.message}`);
      return failure.exitCode;
    }
    const lines = nodes
      .filter(node => options.node === undefined || node.id === options.node)
      .flatMap(node => node.sources
        .filter(source => project === undefined || source.project.id === project)
        .map(source => `${node.id}\t${source.path}\t${source.project.name} (project ${source.project.id})`));
    out(lines.length > 0 ? lines.join("\n") : "No sources.");
    return EXIT_OK;
  },
});
