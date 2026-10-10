/**
 * `reins node run`: runs this machine's paired node in the foreground, linked to the server it was paired
 * with over the WebSocket (`/node-link`), until SIGTERM or SIGINT, or until the server refuses it. The
 * node's lifecycle is the node-only executable's (`runNodeProcess` in `@reins/node`); see
 * docs/dev/node-contract.md *Process model*. Reads `node.json` and the node's key (config.ts).
 *
 * The node serves only its declared sources (`node.json`'s `sources`, `reins node source`). It watches its
 * config while it runs: a change to its sources applies to the next call at once, and the node reconnects
 * so that its next hello reports them to the server.
 */
import { nodeHome } from "@reins/node/node-home";
import { runNodeProcess } from "@reins/node/node-process";
import { connectRemoteNode } from "@reins/node/remote-link";
import { nodeLinkUrl } from "@reins/node-protocol";
import { defineCommand, EXIT_FAILED, EXIT_OK } from "../command.js";
import { loadNodeIdentity, nodeConfigPath, readNodeConfig, watchNodeConfig } from "./config.js";

/** The server refused this node (unknown, revoked or removed, or its key no longer matches): re-pair it. */
const EXIT_REFUSED = 4;

const sameSources = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((source, i) => source === b[i]);

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
    let sources = config.sources;
    let client: ReturnType<typeof connectRemoteNode> | undefined;
    // Only the sources are re-read: the node keeps the identity and server it started with. One read at a
    // time, so a slow read of an older config never undoes a newer one.
    let rereads = Promise.resolve();
    const reread = async () => {
      try {
        const changed = await readNodeConfig(home);
        if (!changed || sameSources(changed.sources, sources)) return;
        sources = changed.sources;
        out("[node] sources changed; reconnecting to report them");
        client?.redial();
      } catch (error) {
        err(`[node] not applying ${nodeConfigPath(home)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const stopWatching = watchNodeConfig(home, () => { rereads = rereads.then(reread); });
    try {
      const exit = await runNodeProcess({
        dataDir: home,
        sources: () => sources,
        nodeId: config.nodeId,
        server: `server at ${nodeLinkUrl(config.serverUrl)}`,
        connect: (node, events) => client = connectRemoteNode(node, { serverUrl: config.serverUrl, nodeId: config.nodeId, identity, ...events }),
        env, out, err,
      });
      if (exit.reason === "refused") {
        err(`Node stopped: ${config.serverUrl} refused it (${exit.message}). Pair this machine again: reins node pair --force ${config.serverUrl} <code>`);
        return EXIT_REFUSED;
      }
      return EXIT_OK;
    } finally {
      stopWatching();
    }
  },
});
