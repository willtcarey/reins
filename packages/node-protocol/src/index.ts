/** `@reins/node-protocol`: everything about talking over the server↔node link, used by both sides. Its
 * files, flat and named for what they hold:
 * - `node-methods.ts`: the methods the node serves (`nodeMethods`);
 * - `server-methods.ts`: the methods the server serves (`serverMethods`: stream frames);
 * - `fields.ts`: field schemas and limits both share (ids, streams, the bounds of files and commands);
 * - `method-table.ts`: the method table shape and the typed serve and call helpers over a table;
 * - `negotiation.ts`: `protocolVersion`, `methods` and the `node.hello` exchange both ends read;
 * - `node-auth.ts`: the `node.authenticate` challenge a paired node answers, its signature and the node key's encoding;
 * - `rpc.ts`: the generic JSON-RPC peer, its sockets and error codes;
 * - `local-socket.ts`: NDJSON framing and the local Unix-socket link's constants and path;
 * - `websocket-link.ts`: the remote WebSocket link's constants, URL and socket adapter;
 * - `errors.ts`: node errors and rejections.
 * The node end of a connection is not here: it is `connectNode` in `@reins/node` (ADR-027). Imports only
 * `zod` (and runtime builtins). Test doubles live in `@reins/node-protocol/testing`. The
 * package entry point, so it re-exports from its modules (lint exempts this file). */
export {
  nodeMethods, MAX_DIRECTORY_ENTRIES,
  type ProcessRun, type NodeReload,
  type FsInfo, type FsInfoResult, type FsList, type FsListResult, type FsRead, type FsReadResult, type FsWrite, type FsWriteResult, type FsPath, type FsPathResult, type FileErrorData,
  execRecord, type PiExec, type PiExecAttach, type PiExecAttachResult, type PiExecKill, type PiExecKillResult, type ExecRecord,
} from "./node-methods.js";
export { serverMethods, type StreamData, type StreamEnd } from "./server-methods.js";
export {
  streamId, type ProcessExit, WRITE_CHUNK_BYTES, STREAM_CHUNK_BYTES, MAX_STREAM_CHUNK_CHARS, MAX_PROCESS_STDERR_CHARS,
  MAX_FILE_ERROR_CHARS,
} from "./fields.js";
export { serveMethods, methodClient, type MethodInput, type MethodCallOptions, type MethodResult, type RequestMethod, type NotificationMethod } from "./method-table.js";
export { protocolVersion, methods, helloParams, readyResult, updateResult, helloErrorResult, helloResult, nodeDocs, type NodeDocs, type Hello, type Ready, type HelloResult, type BuildUpdate } from "./negotiation.js";
export { authenticateParams, authenticateResult, generateNodeKeyPair, encodeNodePublicKey, parseNodePublicKey, newNodeChallenge, signNodeChallenge, verifyNodeAnswer, type NodeChallenge, type NodeAnswer, type NodeKey } from "./node-auth.js";
export {
  createRpcPeer, RpcFailure, NotConnected, systemTimers, MAX_ERROR_MESSAGE,
  METHOD_NOT_FOUND, INTERNAL_ERROR, NEGOTIATION_FAILED, BUSY, UNAUTHORIZED, FRAME_TOO_LARGE, NODE_REFUSED,
  type WireSocket, type LinkSocket, type RpcHandlers,
} from "./rpc.js";
export { ndjsonSocketHandler, defaultLocalNodeSocketPath, HELLO_TIMEOUT_MS, LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, MAX_UNIX_SOCKET_PATH_BYTES, type NdjsonSocket, type LinkOptions } from "./local-socket.js";
export { createWebSocketLink, nodeLinkUrl, NODE_LINK_PATH, REMOTE_LINK, REMOTE_MAX_FRAME_BYTES, type MessageStream, type WebSocketLink } from "./websocket-link.js";
export { APPLICATION_ERROR, nodeError, NodeRejection, type NodeError } from "./errors.js";
