/**
 * `reins node run`: runs this machine's paired node in the foreground, linked to the server it was paired
 * with over the WebSocket (`/nodes/link`), until SIGTERM or SIGINT, or until the server refuses it. The
 * node's lifecycle is the node-only executable's (`runNodeProcess` in `@reins/node`); see
 * docs/dev/node-contract.md *Process model*. Its pairing, identity and status file are the home's
 * (`NodeInstall`, install.ts); it refuses to run while another node of the home runs.
 *
 * Run from a node bundle, its hello announces its build; a server running another build answers `update`
 * (ADR-025), and the node installs that build in its home and exits with the restart code. Its launcher
 * (a `restartable` bundle) then starts the new build; without one, nothing does.
 */
import { runNodeProcess } from "@reins/node/node-process";
import { connectRemoteNode } from "@reins/node/remote-link";
import { nodeLinkUrl } from "@reins/node-protocol";
import { defineCommand, EXIT_FAILED } from "../command.js";
import { NodeInstall } from "./install.js";
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
    const pairing = await install.pairing();
    if (!pairing) {
      err(`Not running: this machine's node is not paired (no ${install.paths.pairing}). Pair it first: reins node pair <server URL> <code>`);
      return EXIT_FAILED;
    }
    const buildId = bundle?.buildId;
    const claim = install.recorder({ serverUrl: pairing.serverUrl, ...(buildId ? { buildId } : {}) });
    if ("runningPid" in claim) {
      err(`Not running: this machine's node is already running (pid ${claim.runningPid}). Stop it first: reins node stop`);
      return EXIT_FAILED;
    }
    const status = claim.recorder;
    const identity = await install.identity(pairing);
    status.set("connecting");
    try {
      const exit = await runNodeProcess({
        dataDir: install.home,
        nodeId: pairing.nodeId,
        server: `server at ${nodeLinkUrl(pairing.serverUrl)}`,
        connect: (node, { onStatus, onRefused, onUpdate }) => connectRemoteNode(node, {
          serverUrl: pairing.serverUrl, nodeId: pairing.nodeId, identity, ...(buildId ? { buildId } : {}),
          onStatus: state => { status.set(state === "connected" ? "connected" : "connecting"); onStatus(state); },
          onRefused: message => { status.set("refused", message); onRefused(message); },
          ...(onUpdate ? { onUpdate } : {}),
        }),
        // From source the node announces no build, so it is never told to update.
        ...(bundle ? { install: update => install.installUpdate(pairing.serverUrl, update) } : {}),
        env, out, err,
      });
      if (exit.reason === "update" && bundle?.restartable) status.set("updating");
      return report({ of: "run", exit, restartable: bundle?.restartable ?? false, pairing }, install, context);
    } finally {
      status.stop();
    }
  },
});
