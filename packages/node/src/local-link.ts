import type { Dial } from "./redial.js";
import { LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, ndjsonSocketHandler, type LinkOptions } from "@reins/node-protocol";

/** The node ID a local node announces in `node.hello` unless configured otherwise (`REINS_NODE_ID`): the
 * ID of the node row the server's migrations seed for this machine. The server has no notion of a local
 * node; it serves any connection whose ID names one of its nodes. */
export const DEFAULT_LOCAL_NODE_ID = "internal";

/**
 * The local link's transport: the server's Unix socket at `path`, NDJSON frames over it, with the local
 * link's options (`LOCAL_LINK`, `overrides` over them). The local socket does not challenge: its file
 * permissions are its authentication.
 */
export function unixDial(path: string, overrides: LinkOptions = {}): Dial {
  const link: LinkOptions = { ...LOCAL_LINK, ...overrides };
  return {
    address: path,
    link,
    // `opened` is wired synchronously on open, before any frame can arrive.
    open: opened => Bun.connect({ unix: path, socket: ndjsonSocketHandler(link.maxFrameBytes ?? LOCAL_MAX_FRAME_BYTES, opened) }),
  };
}
