/**
 * `reins node start`, `stop` and `status`: this machine's installed node as a background process
 * (background.ts), run by its launcher (install.ts). `reins node setup` (setup.ts) starts it the same way
 * (`startInstalledNode`). See docs/dev/node-contract.md *Process model*.
 */
import { existsSync } from "node:fs";
import { nodeHome } from "@reins/node/node-home";
import { defineCommand, EXIT_FAILED, EXIT_OK, type CommandContext } from "../command.js";
import { CONNECT_TIMEOUT_MS, isRunning, launchNode, logPath, readNodeStatus, runningNode, STOP_TIMEOUT_MS, stopNode, waitForConnection, type ConnectResult, type NodeStatus } from "./background.js";
import { nodeConfigPath, readNodeConfig, type NodeConfig } from "./config.js";
import { currentBuildId, launcherPath } from "./install.js";

/** The server refused the node: re-pair it. As `reins node run`'s. */
export const EXIT_REFUSED = 4;
/** `status`: the node is not running. */
const EXIT_NOT_RUNNING = 3;
/** `status`: the node is running but not connected. */
const EXIT_NOT_CONNECTED = 4;

/** How to run `reins` in this home, for hints: its launcher once installed. */
export function reinsCommand(home: string): string {
  const launcher = launcherPath(home);
  return existsSync(launcher) ? launcher : "reins";
}

const shortId = (buildId: string) => buildId.slice(0, 12);

/**
 * Starts the home's installed node in the background unless it is already running, waits for it to
 * connect (or be refused, or exit, or `CONNECT_TIMEOUT_MS`) and prints the outcome as the last line. With
 * `buildId`, a node running another build is stopped and started again. `name`: the node's name, if known.
 * Resolves with the exit code: 0 connected, 4 refused, 1 anything else.
 */
export async function startInstalledNode(home: string, config: NodeConfig, context: CommandContext, options: { buildId?: string; name?: string } = {}): Promise<number> {
  const started = await launchInstalledNode(home, context, options);
  return typeof started === "number" ? started : reportConnection(home, config, context, started, options.name);
}

/** `startInstalledNode` up to the outcome of its wait, which it does not print; a number when the node of
 * another build could not be stopped (printed). */
export async function launchInstalledNode(home: string, { env, out, err }: CommandContext, options: { buildId?: string } = {}): Promise<ConnectResult | number> {
  let running = runningNode(home);
  if (running && options.buildId && running.buildId !== options.buildId) {
    out(`Stopping the node running ${running.buildId ? `build ${shortId(running.buildId)}` : "from source"} (pid ${running.pid})`);
    const stopped = await stopNode(home);
    if (stopped.outcome === "timeout") {
      err(`Node not restarted: the node running the previous build (pid ${running.pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s. Its log is ${logPath(home)}`);
      return EXIT_FAILED;
    }
    running = null;
  }
  let launched;
  if (running) {
    out(`The node is already running${options.buildId ? " this build" : ""} (pid ${running.pid})`);
  } else {
    out(`Starting the node; its log is ${logPath(home)}`);
    launched = launchNode(home, env);
  }
  return waitForConnection(home, { launched, timeoutMs: CONNECT_TIMEOUT_MS });
}

/** Prints what waiting for the node came to as the last line; resolves with the exit code (as
 * `startInstalledNode`'s). */
export function reportConnection(home: string, config: NodeConfig, { out, err }: CommandContext, result: ConnectResult, name?: string): number {
  const log = logPath(home);
  const node = name ? `"${name}" (${config.nodeId})` : config.nodeId;
  switch (result.outcome) {
    case "connected":
      out(`Node ${node} connected to ${config.serverUrl} (pid ${result.status.pid}).`);
      return EXIT_OK;
    case "refused":
      err(`Node not connected: ${config.serverUrl} refused it (${result.status.message ?? "no reason given"}). Pair this machine again: ${reinsCommand(home)} node pair --force ${config.serverUrl} <code>`);
      return EXIT_REFUSED;
    case "exited":
      err(`Node not connected: it exited${result.exitCode === null ? "" : ` (exit ${result.exitCode})`} before connecting to ${config.serverUrl}. Its log is ${log}`);
      return EXIT_FAILED;
    case "timeout":
      err(`Node not connected to ${config.serverUrl} within ${CONNECT_TIMEOUT_MS / 1000} s${result.status && isRunning(result.status) ? `; it keeps trying (pid ${result.status.pid})` : ""}. Its log is ${log}`);
      return EXIT_FAILED;
  }
}

/** The home's config, or why there is none (printed). */
async function pairedConfig(home: string, failure: string, err: (text: string) => void): Promise<NodeConfig | null> {
  const config = await readNodeConfig(home);
  if (!config) err(`${failure}: this machine's node is not paired (no ${nodeConfigPath(home)}). Install it with the command in the server's Settings → Nodes`);
  return config;
}

/** Exit 0 connected, 1 not installed, not paired, exited, not connected in time or an unexpected failure,
 * 4 refused by the server. */
export const nodeStartCommand = defineCommand({
  words: ["node", "start"],
  args: [],
  options: {},
  summary: "Start this machine's installed node in the background and wait until it connects",
  async run(_input, context) {
    const home = nodeHome(context.env);
    const config = await pairedConfig(home, "Not started", context.err);
    if (!config) return EXIT_FAILED;
    if (!existsSync(launcherPath(home))) {
      context.err(`Not started: this node was not installed (no ${launcherPath(home)}). Run it in the foreground instead: reins node run`);
      return EXIT_FAILED;
    }
    return startInstalledNode(home, config, context);
  },
});

/** Exit 0 stopped or not running, 1 still running after the timeout or an unexpected failure. */
export const nodeStopCommand = defineCommand({
  words: ["node", "stop"],
  args: [],
  options: {},
  summary: "Stop this machine's node: its runs pause, and the server resumes them when it next connects",
  async run(_input, { env, out, err }) {
    const home = nodeHome(env);
    const result = await stopNode(home);
    switch (result.outcome) {
      case "not_running":
        out("Node not running.");
        return EXIT_OK;
      case "stopped":
        out(`Node stopped (pid ${result.status.pid}).`);
        return EXIT_OK;
      case "timeout":
        err(`Node not stopped: pid ${result.status.pid} is still running ${STOP_TIMEOUT_MS / 1000} s after SIGTERM. Its log is ${logPath(home)}`);
        return EXIT_FAILED;
    }
  },
});

/** The last line of `status`, and its exit code. */
function stateLine(status: NodeStatus | null, home: string): { line: string; exitCode: number } {
  if (!status) return { line: `Not running. Start it: ${reinsCommand(home)} node start`, exitCode: EXIT_NOT_RUNNING };
  if (status.state === "refused") {
    return { line: `Not running: ${status.serverUrl} refused it at ${status.since} (${status.message ?? "no reason given"}). Pair this machine again: ${reinsCommand(home)} node pair --force ${status.serverUrl} <code>`, exitCode: EXIT_NOT_RUNNING };
  }
  // Its launcher is starting the build it installed.
  if (status.state === "updating") return { line: `Restarting on a new build since ${status.since}.`, exitCode: EXIT_NOT_CONNECTED };
  if (!isRunning(status) || status.state === "stopped") return { line: `Not running (last ${status.state} at ${status.since}). Start it: ${reinsCommand(home)} node start`, exitCode: EXIT_NOT_RUNNING };
  if (status.state === "connected") return { line: `Running (pid ${status.pid}), connected to ${status.serverUrl} since ${status.since}.`, exitCode: EXIT_OK };
  return { line: `Running (pid ${status.pid}), not connected: connecting to ${status.serverUrl} since ${status.since}.`, exitCode: EXIT_NOT_CONNECTED };
}

/** Exit 0 running and connected, 1 not paired or an unexpected failure, 3 not running (stopped, refused or
 * never started), 4 running but not connected, or restarting on a new build. */
export const nodeStatusCommand = defineCommand({
  words: ["node", "status"],
  args: [],
  options: {},
  summary: "Show this machine's node: its pairing, build and whether it runs and is connected",
  async run(_input, { env, out, err }) {
    const home = nodeHome(env);
    const config = await pairedConfig(home, "No node", err);
    if (!config) return EXIT_FAILED;
    const status = readNodeStatus(home);
    const current = await currentBuildId(home);
    const running = status && isRunning(status) && status.state !== "stopped" ? status : null;
    const build = running ? running.buildId ?? "from source" : current ?? "none installed";
    const { line, exitCode } = stateLine(status, home);
    out([
      `Paired with ${config.serverUrl} as node ${config.nodeId}`,
      `Build: ${build}${running && current && running.buildId !== current ? ` (current: ${current})` : ""}`,
      `Log: ${logPath(home)}`,
      line,
    ].join("\n"));
    return exitCode;
  },
});
