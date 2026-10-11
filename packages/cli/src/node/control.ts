/**
 * `reins node start`, `stop` and `status`: this machine's installed node in the background (`NodeInstall`,
 * `@reins/node/install`). `reins node setup` (setup.ts) starts it the same way. See
 * docs/dev/node-contract.md *Process model*.
 */
import { defineCommand, EXIT_FAILED } from "../command.js";
import { NodeInstall } from "@reins/node/install";
import { report, stepLine } from "./outcome.js";

/** Exit 0 connected, 1 not installed, not paired, exited, not connected in time or an unexpected failure,
 * 4 refused by the server. */
export const nodeStartCommand = defineCommand({
  words: ["node", "start"],
  args: [],
  options: {},
  summary: "Start this machine's installed node in the background and wait until it connects",
  async run(_input, context) {
    const { env, out, err } = context;
    const install = NodeInstall.of(env);
    const pairing = await install.pairing();
    if (!pairing) {
      err(`Not started: this machine's node is not paired (no ${install.paths.pairing}). Install it with the command in the server's Settings → Nodes`);
      return EXIT_FAILED;
    }
    if (!install.installed) {
      err(`Not started: this node was not installed (no ${install.paths.launcher}). Run it in the foreground instead: reins node run`);
      return EXIT_FAILED;
    }
    const result = await install.start(env, { onStep: step => out(stepLine(step, install)) });
    return report({ of: "start", result, pairing }, install, context);
  },
});

/** Exit 0 stopped or not running, 1 still running after the timeout or an unexpected failure. */
export const nodeStopCommand = defineCommand({
  words: ["node", "stop"],
  args: [],
  options: {},
  summary: "Stop this machine's node: its running commands exit first, and sessions' tool calls wait for it to connect again",
  async run(_input, context) {
    const install = NodeInstall.of(context.env);
    return report({ of: "stop", result: await install.stop() }, install, context);
  },
});

/** Exit 0 running and connected, 1 not paired or an unexpected failure, 3 not running (stopped, refused or
 * never started), 4 running but not connected, or restarting on a new build. */
export const nodeStatusCommand = defineCommand({
  words: ["node", "status"],
  args: [],
  options: {},
  summary: "Show this machine's node: its pairing, build and whether it runs and is connected",
  async run(_input, context) {
    const { env, out, err } = context;
    const install = NodeInstall.of(env);
    const pairing = await install.pairing();
    if (!pairing) {
      err(`No node: this machine's node is not paired (no ${install.paths.pairing}). Install it with the command in the server's Settings → Nodes`);
      return EXIT_FAILED;
    }
    const status = install.status();
    const current = await install.currentBuild();
    const running = status?.running && status.state !== "stopped" && status.state !== "starting" ? status : null;
    const build = running ? running.buildId ?? "from source" : current ?? "none installed";
    out([
      `Paired with ${pairing.serverUrl} as node ${pairing.nodeId}`,
      `Build: ${build}${running && current && running.buildId !== current ? ` (current: ${current})` : ""}`,
      `Log: ${install.paths.log}`,
    ].join("\n"));
    return report({ of: "status", status, pairing }, install, context);
  },
});
