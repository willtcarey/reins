/**
 * `reins node reload [nodeId] [--force] [--server <url>] [--local]`: asks a Reins server to restart a node
 * on its new code; by default this machine's paired node on its server, else the local server's local
 * node (server.ts). `bun run node:reload` passes `--local`. It exits once the reload is scheduled: the
 * node holds its runs at their next pause point, restarts when nothing is in flight and the server resumes
 * the runs (ADR-021). `--force` cuts off calls still in flight at the node's 60 s bound instead of
 * cancelling the reload. Same as `POST /api/nodes/:nodeId/reload`.
 */
import { defineCommand, EXIT_OK } from "../command.js";
import { requestFailure, resolveServer, serverOptions } from "../server.js";

export const nodeReloadCommand = defineCommand({
  words: ["node", "reload"],
  args: ["nodeId?"],
  options: {
    force: { type: "boolean", description: "Cut off calls still in flight after 60 s instead of cancelling the reload" },
    ...serverOptions,
  },
  summary: "Restart a node on its new code (this machine's node by default)",
  async run({ args: [nodeId], options }, { env, out, err }) {
    const { serverUrl, nodeId: node, client } = await resolveServer(options, env, nodeId);
    try {
      await client.nodes.reload(node, { force: options.force });
    } catch (error) {
      const failure = requestFailure(error, serverUrl);
      err(`Node ${node} did not reload: ${failure.message}`);
      return failure.exitCode;
    }
    out(`Node ${node} reload scheduled: it restarts once its runs reach a pause point, and they continue on the new code.`);
    return EXIT_OK;
  },
});
