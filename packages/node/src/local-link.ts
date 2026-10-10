import type { Node } from "./node.js";
import { redialNode, type NodeLinkClient, type RedialOptions } from "./redial.js";
import { LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, ndjsonSocketHandler, type LinkOptions } from "@reins/node-protocol";

/** The node ID a local node announces in `node.hello` unless configured otherwise (`REINS_NODE_ID`): the
 * ID of the node row the server's migrations seed for this machine. The server has no notion of a local
 * node; it serves any connection whose ID names one of its nodes. */
export const DEFAULT_LOCAL_NODE_ID = "internal";

interface LocalNodeClientOptions extends LinkOptions, RedialOptions {
  /** The server's Unix socket. */
  path: string;
  /** Announced in `node.hello`; `DEFAULT_LOCAL_NODE_ID` by default. */
  nodeId?: string;
  /** Announced in `node.hello`: the node bundle this node runs; none from source. */
  buildId?: string;
}

/**
 * Node side of the local link: dials the server's Unix socket and runs the node protocol over NDJSON
 * frames, redialing with backoff and stopping on a refusal (`redialNode`). The local socket does not
 * challenge: its file permissions are its authentication.
 */
export function connectLocalNode(node: Node, options: LocalNodeClientOptions): NodeLinkClient {
  const { path, nodeId = DEFAULT_LOCAL_NODE_ID, backoff, updateBackoff, random, onStatus, onRefused, onUpdate, buildId, ...overrides } = options;
  const link: LinkOptions = { ...LOCAL_LINK, ...overrides };
  // `opened` is wired synchronously on open, before any frame can arrive.
  const dial = (opened: Parameters<typeof ndjsonSocketHandler>[1]) =>
    Bun.connect({ unix: path, socket: ndjsonSocketHandler(link.maxFrameBytes ?? LOCAL_MAX_FRAME_BYTES, opened) });
  return redialNode(node, dial, nodeId, { ...link, ...(buildId ? { buildId } : {}) }, { backoff, updateBackoff, random, onStatus, onRefused, onUpdate });
}
