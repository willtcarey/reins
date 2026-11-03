/**
 * `reins source list [--project <id>] [--node <nodeId>]`: the sources in use on nodes (locations: directories
 * sessions work in, or a project's default source), with the projects using each, from a Reins server (`GET
 * /api/nodes`; which server: server.ts). Sources belong to no project and are made on first use (ADR-034):
 * there is nothing to add.
 */
import { defineCommand, EXIT_OK, UsageError } from "./command.js";
import { requestFailure, resolveServer, serverOptions } from "./server.js";

/** A `--project` value: a project ID. */
function projectId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError("--project takes a project ID.");
  return Number(value);
}

/** One line per source: its node, path and the projects using it. Exit 0, 1 the server's refusal, 2 usage, 5
 * no server answering. */
export const sourceListCommand = defineCommand({
  words: ["source", "list"],
  args: [],
  options: {
    project: { type: "string", value: "id", description: "Only the sources that project uses" },
    node: { type: "string", value: "nodeId", description: "Only the sources on that node" },
    ...serverOptions,
  },
  summary: "List the sources in use on nodes, with the projects using them",
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
        .filter(source => project === undefined || source.projects.some(used => used.id === project))
        .map(source => `${node.id}\t${source.path}\t${source.projects.length > 0 ? source.projects.map(used => `${used.name} (project ${used.id})`).join(", ") : "no project"}`));
    out(lines.length > 0 ? lines.join("\n") : "No sources.");
    return EXIT_OK;
  },
});
