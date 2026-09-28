import { homedir } from "node:os";
import { join } from "node:path";
import type { Heartbeat, PeerOptions } from "./peer.js";

/**
 * The local node link: JSON-RPC over a Unix domain stream socket with newline-delimited frames
 * (`ndjson.ts`). Shared by the server listener and the node client; see docs/dev/node-contract.md
 * *Transport*.
 */

/** Frame cap on the local socket. The in-memory loopback is uncapped; this permission-protected socket
 * uses a large cap so ordinary commit batches and prompts cross in one frame (see node-contract.md
 * *Frame caps*) while a misbehaving peer cannot grow a partial frame without bound. */
export const LOCAL_MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** A connection that has not negotiated `node.hello` within this bound is closed, on both sides. */
export const HELLO_TIMEOUT_MS = 10_000;
/** `node.ping` every 10s; a peer silent for 3 intervals (30–40s) is treated as dead. */
export const HEARTBEAT: Heartbeat = { intervalMs: 10_000, missedIntervals: 3 };
/** Connection options for either end of a link that crosses a process boundary. */
export interface LinkOptions extends PeerOptions {
  /** Close a connection that has not negotiated within this bound (no bound when omitted). */
  helloTimeoutMs?: number;
}
export const LOCAL_LINK: LinkOptions = { maxFrameBytes: LOCAL_MAX_FRAME_BYTES, heartbeat: HEARTBEAT, helloTimeoutMs: HELLO_TIMEOUT_MS };

/** Default endpoint, beside the node's own storage under `~/.reins` (not `REINS_DATA_DIR`, which is the
 * server's): server and node agree on it without configuration. */
export function defaultLocalNodeSocketPath(home: string = homedir()): string {
  return join(home, ".reins", "run", "node.sock");
}
/** `sun_path` holds 108 bytes on Linux and 104 on macOS, including the terminating NUL. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;
