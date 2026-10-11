/** What negotiating a connection takes, for both ends: the protocol version, the `node.hello` exchange and
 * the full list of method names. (These live here rather than in `method-table.ts`, which knows no concrete
 * method: `methods` needs both tables, and the tables load `method-table.ts`.) The node end of a connection
 * is `connectNode` in `@reins/node`; the server's is `server-peer.ts` in the backend. */
import { z } from "zod";
import { HEARTBEAT_METHOD, MAX_ERROR_MESSAGE } from "./rpc.js";
import { id, sha256 } from "./fields.js";
import { methodKeys } from "./method-table.js";
import { capability, nodeMethods } from "./node-methods.js";
import { serverMethods } from "./server-methods.js";

/** Wire protocol version, negotiated in `node.hello`; independent of how the server stores commands. The
 * hello's envelope and its reply kinds are not versioned by it: they are bootstrap surface (`helloParams`,
 * `helloResult`), read by nodes and servers of other releases, and change only additively. */
export const protocolVersion = 10 as const;
/** Every wire method name, keyed `scopeName`. Named for what is happening, not which side serves it:
 * commands are imperatives, requests name the resource, reports are past tense; `node.` is
 * connection-level (`node.authenticate` proves the node before and `node.hello` negotiates the epoch the
 * tables' methods carry, so they are in neither). */
export const methods = { nodeAuthenticate: "node.authenticate", nodeHello: "node.hello", nodePing: HEARTBEAT_METHOD, ...methodKeys(nodeMethods), ...methodKeys(serverMethods) } as const;
/** Upper bound on `node.hello`'s `liveSessions`. */
export const MAX_LIVE_SESSIONS = 4096;
/**
 * `node.hello`'s params. Bootstrap surface (ADR-025): a server must read the hello of a node of any release
 * far enough to tell it to update, so this envelope only grows. It parses tolerantly: fields a newer node
 * sends that this server does not know are dropped, not refused.
 */
export const helloParams = z.object({
  minVersion: z.number().int().positive(), maxVersion: z.number().int().positive(),
  capabilities: z.array(id).max(16),
  /** The connecting node's ID: the server serves the connection only for a node it knows (a `nodes` row). */
  nodeId: id,
  /** Sessions with a run in progress on the node when it dialed. After negotiation the server resumes
   * every other session on this node it still sees running: the node lost its run (ADR-021). */
  liveSessions: z.array(id).max(MAX_LIVE_SESSIONS),
  /** The node bundle it runs: the sha256 of its `reins.js`. Absent from source (the local node). A server
   * whose own build differs answers `update` instead of negotiating. */
  buildId: sha256.optional(),
}).refine(value => value.minVersion <= value.maxVersion);

/** The hello's reply, by `kind` (ADR-025). Bootstrap surface: a node reads the reply of a server of any
 * later release, so kinds and fields are only added, and a node parses tolerantly (its kind first). */
export const readyResult = z.object({
  kind: z.literal("ready"),
  version: z.literal(protocolVersion), capabilities: z.array(capability).max(16), epoch: z.string().uuid(),
});
/** Install this build and restart on it, instead of negotiating: from `<server>/nodes/builds/<buildId>/reins.js`
 * on the server the node is paired with, checked against `sha256`, on Bun `bunVersion`. */
export const updateResult = z.object({
  kind: z.literal("update"),
  buildId: sha256, sha256, bunVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/).max(64),
});
/** The server cannot serve this node at all (e.g. a bootstrap format it no longer accepts): the node stops,
 * and the user reinstalls it. */
export const helloErrorResult = z.object({
  kind: z.literal("error"),
  code: z.string().min(1).max(64), message: z.string().max(MAX_ERROR_MESSAGE),
});
/** What a server answers, checked as it sends it. */
export const helloResult = z.discriminatedUnion("kind", [readyResult, updateResult, helloErrorResult]);
export type Hello = z.infer<typeof helloParams>;
export type Ready = z.infer<typeof readyResult>;
export type HelloResult = z.infer<typeof helloResult>;
/** The build an `update` reply names. */
export type BuildUpdate = Omit<z.infer<typeof updateResult>, "kind">;
