/**
 * Node-only executable: a node in its own process, linked to the server over the local socket.
 *
 * Holds no session state on disk (ADR-015; its data directory, `REINS_NODE_DATA_DIR` or `~/.reins`, holds
 * only unfinished file writes): starts the node and dials the server's local socket
 * (`REINS_NODE_SOCKET`, default `~/.reins/run/node.sock`), redialing with backoff whenever the server is
 * absent or the connection drops, so it may start before the server. It never imports server code or
 * opens the server database (Oxlint `reins/node-implementation-isolation`). The lifecycle (signals,
 * pausing, refusal, reload) is `runNodeProcess`'s, shared with `reins node run`; this file picks the
 * transport (`unixTransport`) and the exit codes. See node-contract.md *Process model*.
 *
 * SIGTERM/SIGINT pause the runs, stop the node and exit 0. Nothing reloads this process on a code change.
 * Under the supervisor (`REINS_NODE_RELOAD_EXIT_CODE`) it serves `node.reload`: once its runs are paused
 * it stops and exits with that code, and the supervisor starts it again at once on its new code (see
 * docs/dev/hot-reload.md). A server that refuses this node (`NODE_REFUSED`: an unknown or revoked node) is
 * not redialed: the node stops and exits with `REINS_NODE_REFUSED_EXIT_CODE` (1 without it), which the
 * supervisor does not restart.
 */
import { NodeInstall } from "./install.js";
import { DEFAULT_LOCAL_NODE_ID, unixTransport } from "./local-link.js";
import { runNodeProcess } from "./node-process.js";
import { defaultLocalNodeSocketPath } from "@reins/node-protocol";

const socketPath = process.env.REINS_NODE_SOCKET?.trim() || defaultLocalNodeSocketPath();
/** The node this process is: the server serves the connection only if it has a node with this ID. */
const nodeId = process.env.REINS_NODE_ID?.trim() || DEFAULT_LOCAL_NODE_ID;

/** Set by the supervisor: the exit code that has it start this node again at once. */
const reloadExitCode = Number.parseInt(process.env.REINS_NODE_RELOAD_EXIT_CODE ?? "", 10);
/** Set by the supervisor: the exit code that has it leave this node stopped. */
const refusedExitCode = Number.parseInt(process.env.REINS_NODE_REFUSED_EXIT_CODE ?? "", 10);

const exit = await runNodeProcess({
  dataDir: NodeInstall.of(process.env).home,
  transport: unixTransport(socketPath),
  nodeId,
  // Bundles this node's own sources (dependencies stay external), so a syntax or import error refuses the
  // reload instead of leaving the node down.
  ...(Number.isInteger(reloadExitCode) ? {
    async checkReload() {
      const result = await Bun.build({ entrypoints: [import.meta.path], target: "bun", packages: "external", throw: false });
      if (!result.success) throw new Error(result.logs.map(entry => entry.message).join("\n") || "build failed");
    },
  } : {}),
});
process.exit(exit.reason === "reload" ? reloadExitCode : exit.reason === "refused" ? (Number.isInteger(refusedExitCode) ? refusedExitCode : 1) : 0);
