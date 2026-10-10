/**
 * `reins node run`: runs this machine's paired node in the foreground, linked to the server it was paired
 * with over the WebSocket (`/node-link`), until SIGTERM or SIGINT, or until the server refuses it. The
 * node's lifecycle is the node-only executable's (`runNodeProcess` in `@reins/node`); see
 * docs/dev/node-contract.md *Process model*. Reads `node.json` and the node's key (config.ts).
 */
import { nodeHome } from "@reins/node/node-home";
import { runNodeProcess } from "@reins/node/node-process";
import { connectRemoteNode } from "@reins/node/remote-link";
import { nodeLinkUrl } from "@reins/node-protocol";
import { defineCommand, EXIT_FAILED, EXIT_OK } from "../command.js";
import { loadNodeIdentity, nodeConfigPath, readNodeConfig } from "./config.js";

/** The server refused this node (unknown, revoked or removed, or its key no longer matches): re-pair it. */
const EXIT_REFUSED = 4;

/** Exit 0 stopped by a signal, 1 not paired or an unexpected failure, 4 refused by the server. The home is
 * `REINS_NODE_DATA_DIR`, default `~/.reins`. */
export const nodeRunCommand = defineCommand({
  words: ["node", "run"],
  args: [],
  options: {},
  summary: "Run this machine's paired node in the foreground until stopped",
  async run(_input, { env, out, err }) {
    const home = nodeHome(env);
    const config = await readNodeConfig(home);
    if (!config) {
      err(`Not running: this machine's node is not paired (no ${nodeConfigPath(home)}). Pair it first: reins node pair <server URL> <code>`);
      return EXIT_FAILED;
    }
    const identity = await loadNodeIdentity(config);
    const exit = await runNodeProcess({
      dataDir: home,
      nodeId: config.nodeId,
      server: `server at ${nodeLinkUrl(config.serverUrl)}`,
      connect: (node, events) => connectRemoteNode(node, { serverUrl: config.serverUrl, nodeId: config.nodeId, identity, ...events }),
      env, out, err,
    });
    if (exit.reason === "refused") {
      err(`Node stopped: ${config.serverUrl} refused it (${exit.message}). Pair this machine again: reins node pair --force ${config.serverUrl} <code>`);
      return EXIT_REFUSED;
    }
    return EXIT_OK;
  },
});
