/**
 * `reins node run`: runs this machine's paired node in the foreground, linked to the server it was paired
 * with over the WebSocket (`/nodes/link`), until SIGTERM or SIGINT, or until the server refuses it. The
 * node is `runInstalledNode`'s (`@reins/node/node-process`): its pairing, key and status file, its
 * lifecycle, and, run from a node bundle, the updates it installs (ADR-025); this prints how it ended. See
 * docs/dev/node-contract.md *Process model*.
 */
import { NodeInstall } from "@reins/node/install";
import { runInstalledNode } from "@reins/node/node-process";
import { defineCommand } from "../command.js";
import { report } from "./outcome.js";

/** Exit 0 stopped by a signal, 1 not paired, already running or an unexpected failure, 4 refused by the
 * server, 75 (`RESTART_EXIT_CODE`) updated: a new build is current, to be started. The home is
 * `REINS_NODE_DATA_DIR`, default `~/.reins`. */
export const nodeRunCommand = defineCommand({
  words: ["node", "run"],
  args: [],
  options: {},
  summary: "Run this machine's paired node in the foreground until stopped",
  async run(_input, context) {
    const { env, bundle, out, err } = context;
    const install = NodeInstall.of(env);
    const exit = await runInstalledNode(install, bundle, { env, out, err });
    return report({ of: "run", exit, restartable: bundle?.restartable ?? false }, install, context);
  },
});
