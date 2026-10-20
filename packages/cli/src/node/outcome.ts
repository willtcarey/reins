/**
 * What became of this machine's node, as `reins node run`, `start`, `setup`, `stop` and `status` print it:
 * their last line and exit code, defined once (`report`), with what `start` says as it goes (`stepLine`).
 */
import { RESTART_EXIT_CODE, type NodeInstall, type NodeStatus, type Pairing, type StartResult, type StartStep, type StopResult } from "@reins/node/install";
import type { InstalledNodeExit } from "@reins/node/node-process";
import { EXIT_FAILED, EXIT_OK, type CommandContext } from "../command.js";

/** The server refused: the node (`run`, `start`, `setup`) or the pairing code (`pair`, `setup`). */
export const EXIT_REFUSED = 4;
/** `status`: the node is not running. */
const EXIT_NOT_RUNNING = 3;
/** `status`: the node is running but not connected. */
const EXIT_NOT_CONNECTED = 4;

export type NodeOutcome =
  /** `run`: why the node did not run or stopped; `restartable`: a launcher runs it again (a bundle's
   * `restartable`). */
  | { of: "run"; exit: InstalledNodeExit; restartable: boolean }
  /** `start`, `setup`: what starting it came to; `name`: the node's, when known. */
  | { of: "start"; result: StartResult; pairing: Pairing; name?: string }
  | { of: "stop"; result: StopResult }
  | { of: "status"; status: NodeStatus | null; pairing: Pairing };

/** Prints the outcome's last line, if it has one (the node's own log line is `run`'s otherwise), and resolves
 * with its exit code. */
export function report(outcome: NodeOutcome, install: NodeInstall, { out, err }: Pick<CommandContext, "out" | "err">): number {
  const { line, exitCode, error } = describe(outcome, install);
  if (line !== undefined) (error ? err : out)(line);
  return exitCode;
}

/** What `start` is doing, as a line. */
export function stepLine(step: StartStep, install: NodeInstall): string {
  switch (step.step) {
    case "stopping": return `Stopping the node running ${step.buildId ? `build ${shortId(step.buildId)}` : "from source"} (pid ${step.pid})`;
    case "running": return `The node is already running${step.thisBuild ? " this build" : ""} (pid ${step.pid})`;
    case "restarting": return `The node (pid ${step.pid}) has not connected since ${step.since}${step.message ? ` (${step.message})` : ""}; restarting it`;
    case "launching": return `Starting the node; its log is ${install.paths.log}`;
    case "waiting": return `Not connected yet: ${step.message}`;
  }
}

const shortId = (buildId: string) => buildId.slice(0, 12);
const reason = (message: string | undefined) => message ?? "no reason given";

type Described = { line?: string; exitCode: number; error: boolean };
const ok = (line?: string): Described => ({ ...(line === undefined ? {} : { line }), exitCode: EXIT_OK, error: false });
const failed = (line: string, exitCode = EXIT_FAILED): Described => ({ line, exitCode, error: true });
/** A line of `status`, which describes and so never fails. */
const stated = (line: string, exitCode: number): Described => ({ line, exitCode, error: false });

function describe(outcome: NodeOutcome, install: NodeInstall): Described {
  const log = install.paths.log;
  const pairAgain = (serverUrl: string) => `Pair this machine again: ${install.command()} node pair --force ${serverUrl} <code>`;
  const startIt = `Start it: ${install.command()} node start`;

  switch (outcome.of) {
    case "run": {
      const { exit } = outcome;
      if (exit.reason === "unpaired") return failed(`Not running: this machine's node is not paired (no ${install.paths.pairing}). Pair it first: reins node pair <server URL> <code>`);
      if (exit.reason === "running") return failed(`Not running: this machine's node is already running (pid ${exit.pid}). Stop it first: reins node stop`);
      if (exit.reason === "refused") return failed(`Node stopped: ${exit.serverUrl} refused it (${exit.message}). ${pairAgain(exit.serverUrl)}`, EXIT_REFUSED);
      if (exit.reason !== "update") return ok();
      // Its launcher starts the new build; the node said so last.
      if (outcome.restartable) return { exitCode: RESTART_EXIT_CODE, error: false };
      return { line: `Node updated to build ${shortId(exit.buildId)}, and nothing restarts it here: start it again with ${install.command()} node start`, exitCode: RESTART_EXIT_CODE, error: false };
    }
    case "start": {
      const { result, pairing } = outcome;
      const node = outcome.name ? `"${outcome.name}" (${pairing.nodeId})` : pairing.nodeId;
      switch (result.outcome) {
        case "connected": return ok(`Node ${node} connected to ${pairing.serverUrl} (pid ${result.pid}).`);
        case "refused": return failed(`Node not connected: ${pairing.serverUrl} refused it (${reason(result.message)}). ${pairAgain(pairing.serverUrl)}`, EXIT_REFUSED);
        case "exited": return failed(`Node not connected: it exited${result.exitCode === null ? "" : ` (exit ${result.exitCode})`} before connecting to ${pairing.serverUrl}. Its log is ${log}`);
        case "timeout": return failed(`Node not connected to ${pairing.serverUrl} within ${result.afterMs / 1000} s${result.message === undefined ? "" : ` (${result.message})`}${result.pid === undefined ? "" : `; it keeps trying (pid ${result.pid})`}. Its log is ${log}`);
        case "not_stopped": return failed(`Node not restarted: the node running the previous build (pid ${result.pid}) did not stop within ${result.afterMs / 1000} s. Its log is ${log}`);
      }
    }
    case "stop": {
      const { result } = outcome;
      switch (result.outcome) {
        case "not_running": return ok("Node not running.");
        case "stopped": return ok(`Node stopped (pid ${result.pid}).`);
        case "timeout": return failed(`Node not stopped: pid ${result.pid} is still running ${result.afterMs / 1000} s after SIGTERM. Its log is ${log}`);
      }
    }
    case "status": {
      const { status, pairing } = outcome;
      if (!status) return stated(`Not running. ${startIt}`, EXIT_NOT_RUNNING);
      const serverUrl = status.serverUrl ?? pairing.serverUrl;
      if (status.state === "refused") return stated(`Not running: ${serverUrl} refused it at ${status.since} (${reason(status.message)}). ${pairAgain(serverUrl)}`, EXIT_NOT_RUNNING);
      if (!status.running || status.state === "stopped") return stated(`Not running (last ${status.state} at ${status.since}). ${startIt}`, EXIT_NOT_RUNNING);
      // Its launcher is starting the build it installed.
      if (status.state === "updating") return stated(`Restarting on a new build since ${status.since}.`, EXIT_NOT_CONNECTED);
      if (status.state === "connected") return stated(`Running (pid ${status.pid}), connected to ${serverUrl} since ${status.since}.`, EXIT_OK);
      if (status.state === "starting") return stated(`Running (pid ${status.pid}), not connected: starting since ${status.since}.`, EXIT_NOT_CONNECTED);
      if (status.message) return stated(`Running (pid ${status.pid}), not connected to ${serverUrl} since ${status.since}: ${status.message}.`, EXIT_NOT_CONNECTED);
      return stated(`Running (pid ${status.pid}), not connected: connecting to ${serverUrl} since ${status.since}.`, EXIT_NOT_CONNECTED);
    }
  }
}
