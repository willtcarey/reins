/**
 * A node as a process: what the node-only executable (`main.ts`, over the local socket: `runNodeProcess`)
 * and `reins node run` (`@reins/cli`, this machine's installed node over the WebSocket to the server it was
 * paired with: `runInstalledNode`) run in the foreground. See node-contract.md *Process model*.
 *
 * `runNodeProcess` starts the node and its link over the transport it is given (`redialNode` over a `Dial`)
 * and resolves, once the node has stopped, with why it stopped; the caller exits with its own code for each
 * reason. It logs the link's state and tells `onState`. SIGTERM/SIGINT: hold every run at its next pause
 * point (bounded by SHUTDOWN_PAUSE_MS, then whatever is still in flight is cut off), stop redialing and
 * close the connection, close every runtime without aborting its run (bounded by SHUTDOWN_TIMEOUT_MS). The
 * server resumes the runs when a node next connects (ADR-021). A server that refuses this node
 * (`NODE_REFUSED`) is not redialed: the node stops the same way. Given `checkReload`, it serves
 * `node.reload`: once its runs are paused it stops the same way, for whatever runs it to start it again
 * on its new code. Given `installUpdate` (a node bundle), a server that answers its hello with `update`
 * (ADR-025) has it install that build, then stop without pausing (it cannot reach the new server, so its
 * runs cannot reach a pause point), for whatever runs it to start the new build.
 */
import type { BuildUpdate } from "@reins/node-protocol";
import type { Env, NodeInstall, RunningBundle } from "./install.js";
import type { Node, NodeReloader } from "./node.js";
import { startNode } from "./node.js";
import { redialNode, type Dial, type LinkState, type NodeHello } from "./redial.js";
import { webSocketDial } from "./remote-link.js";

/** How long SIGTERM waits for runs to reach a pause point before cutting off what is still in flight. */
const SHUTDOWN_PAUSE_MS = 3_000;
/** Closing runtimes that does not finish in time is cut short, as by a crash. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** False only in a production node bundle, whose build defines it (packages/backend/src/node-bundle/bundler.ts)
 * so that the test hooks' code is left out; undefined from source. Tested inline (`typeof`), not through a
 * variable: only a condition on the defined name itself is eliminated. */
declare const REINS_TEST_HOOKS: boolean | undefined;

/** Why the node stopped: a signal, the server refusing it (its reason), a reload, or an update it installed. */
export type NodeExit = { reason: "signal" } | { reason: "refused"; message: string } | { reason: "reload" } | { reason: "update"; buildId: string };

/** Where a node process's log lines go (each prefixed `[node] `), and the environment its test hook reads. */
export interface NodeProcessIo {
  /** `REINS_NODE_TEST_FAUX_PROVIDER` (a test hook) is read from it; `process.env` by default. */
  env?: Env;
  /** stdout and stderr by default. */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface NodeProcessOptions {
  /** The node's own files (none durable: unfinished `fs.write`s). */
  dataDir: string;
  /** How it reaches its server: `unixDial` (local-link.ts) or `webSocketDial` (remote-link.ts). */
  dial: Dial;
  /** What its every hello announces. */
  hello: NodeHello;
  /** Hears the link's state: `connecting` as it starts dialing, then each change `redialNode` reports. */
  onState?: (link: LinkState) => void;
  /** Only where something restarts the node when it stops for a reload (the supervisor): checks that its
   * new code builds, throwing the build error to refuse the reload. */
  checkReload?: () => Promise<void>;
  /** Only for a node bundle: installs the build an `update` reply names, so that it runs when the node next
   * starts, throwing why it could not (the link asks the server again later). */
  installUpdate?: (update: BuildUpdate) => Promise<void>;
  /** This process's environment, stdout and stderr by default. */
  io?: NodeProcessIo;
}

/** Runs a node in this process until it stops; resolves with why. */
export async function runNodeProcess(options: NodeProcessOptions): Promise<NodeExit> {
  const { dataDir, dial, hello, onState, checkReload, installUpdate } = options;
  const { env = process.env, out = console.log, err = console.error } = options.io ?? {};
  const server = `server at ${dial.address}`;
  const log = (message: string) => out(`[node] ${message}`);

  // TEST HOOK ONLY (see testing/faux-provider.ts): lets process-level tests drive a scripted model.
  if (typeof REINS_TEST_HOOKS === "undefined" || REINS_TEST_HOOKS) {
    const testFauxProvider = env.REINS_NODE_TEST_FAUX_PROVIDER?.trim();
    if (testFauxProvider) {
      const { registerTestFauxProvider } = await import("./testing/faux-provider.js");
      registerTestFauxProvider(testFauxProvider);
      log(`TEST: registered faux provider ${testFauxProvider}`);
    }
  }

  let finished!: (exit: NodeExit) => void;
  const done = new Promise<NodeExit>(resolve => { finished = resolve; });
  const reload: NodeReloader | undefined = checkReload && {
    check: checkReload,
    restart: () => {
      log("runs paused; restarting on new code");
      void stop({ reason: "reload" });
    },
  };
  const node: Node = startNode({ dataDir, ...(reload ? { reload } : {}) });
  onState?.({ state: "connecting" });
  const link = redialNode(node, dial, hello, {
    onState(state) {
      if (state.state === "connected") log(`connected to ${server}`);
      else if (state.state === "connecting") log("disconnected from server; redialing");
      else log(`refused by the server: ${state.message}; not reconnecting`);
      onState?.(state);
      if (state.state === "refused") void shutdown({ reason: "refused", message: state.message });
    },
    ...(installUpdate ? {
      async onUpdate(update: BuildUpdate) {
        const build = update.buildId.slice(0, 12);
        log(`the server runs build ${build}; updating to it`);
        await installUpdate(update);
        log(`build ${build} installed; restarting on it`);
        void stop({ reason: "update", buildId: update.buildId });
      },
    } : {}),
  });
  log(`dialing ${server} as node ${hello.nodeId} (pid ${process.pid})`);

  let stopping = false;
  /** Closes the connection, closes every runtime without aborting its run and finishes. Pause first. */
  async function stop(exit: NodeExit): Promise<void> {
    if (stopping) return;
    stopping = true;
    link.stop();
    const timeout = new Promise<"timeout">(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS, "timeout").unref());
    if (await Promise.race([node.shutdown().then(() => "done" as const), timeout]) === "timeout") {
      err(`[node] runtimes did not close within ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
    }
    if (exit.reason !== "update") log("stopped");
    finished(exit);
  }
  /** Pauses every run (bounded by SHUTDOWN_PAUSE_MS, then cut off), then stops. */
  async function shutdown(exit: NodeExit): Promise<void> {
    if (stopping) return;
    const { paused, blocking } = await node.pause({ timeoutMs: SHUTDOWN_PAUSE_MS, force: true });
    if (!paused || blocking.length > 0) log(`cutting off work still in flight: ${blocking.join(", ")}`);
    await stop(exit);
  }
  const onSignal = (signal: string) => () => {
    if (stopping) return;
    log(`received ${signal}; pausing runs`);
    void shutdown({ reason: "signal" });
  };
  const onTerm = onSignal("SIGTERM");
  const onInt = onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    return await done;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}

/** Why an installed node did not run (`unpaired`; `running`: another node of its home runs, `pid`), or why
 * it stopped, linked to the server at `serverUrl`. */
export type InstalledNodeExit = { reason: "unpaired" } | { reason: "running"; pid: number } | (NodeExit & { serverUrl: string });

/**
 * Runs this machine's installed node (`install`) in the foreground until it stops: the paired node, linked
 * to the server it was paired with over the WebSocket (`webSocketDial`), announcing its key and, run from a
 * node bundle (`bundle`), its build. It claims the home's status file first, so it does not run while
 * another node of the home runs, and records its link's state there as it goes, `stopped` when it exits
 * (`NodeInstall.recorder`). Told to update, a bundle installs the server's build in the home
 * (`NodeInstall.installUpdate`), records `updating` if a launcher runs it again (`restartable`; otherwise
 * `stopped`) and stops; from source it announces no build, so it is never told to.
 */
export async function runInstalledNode(install: NodeInstall, bundle: RunningBundle | undefined, io: NodeProcessIo = {}): Promise<InstalledNodeExit> {
  const pairing = await install.pairing();
  if (!pairing) return { reason: "unpaired" };
  const { serverUrl, nodeId } = pairing;
  const buildId = bundle?.buildId;
  const claim = install.recorder({ serverUrl, ...(buildId ? { buildId } : {}) });
  if ("runningPid" in claim) return { reason: "running", pid: claim.runningPid };
  const status = claim.recorder;
  const identity = await install.identity(pairing);
  try {
    const exit = await runNodeProcess({
      dataDir: install.home,
      dial: webSocketDial(serverUrl),
      hello: { nodeId, identity, buildId },
      onState: link => status.set(link.state, link.state === "refused" ? link.message : undefined),
      ...(bundle ? { installUpdate: update => install.installUpdate(serverUrl, update) } : {}),
      io,
    });
    if (exit.reason === "update" && bundle?.restartable) status.set("updating");
    return { ...exit, serverUrl };
  } finally {
    status.stop();
  }
}
