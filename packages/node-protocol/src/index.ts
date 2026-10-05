/** `@reins/node-protocol`: everything about talking over the server↔node link, used by both sides. Its
 * files, flat and named for what they hold:
 * - `node-methods.ts`: the methods the node serves (`nodeMethods`, the capabilities) and the server's
 *   stored session commands (`nodeCommand`, `nodeResult`);
 * - `server-methods.ts`: the methods the server serves (`serverMethods`) and the Reins tool call surface;
 * - `fields.ts`: field schemas and limits both share (ids, attachment and image fields, prompt content);
 * - `method-table.ts`: the method table shape and the typed serve and call helpers over a table;
 * - `node-connection.ts`: the node end of a connection, `protocolVersion`, `methods` and `node.hello`;
 * - `rpc.ts`: the generic JSON-RPC peer, its sockets and error codes;
 * - `local-socket.ts`: NDJSON framing and the local Unix-socket link's constants and path;
 * - `streams.ts`: the node end of streams (the sender a stream-opening request's handler starts);
 * - `errors.ts`: node errors and rejections; `session-events.ts`: the runtime event shapes `session.event`
 *   carries and their image helpers.
 * Imports only `zod` (and runtime builtins). Test doubles live in `@reins/node-protocol/testing`. The
 * package entry point, so it re-exports from its modules (lint exempts this file). */
export {
  sessionInputResult, sessionSetModelResult, sessionAbortResult, sessionResumeResult,
  nodeMethods, capability, nodeCommand, nodeResult, MAX_LISTED_SKILLS, MAX_DIRECTORY_ENTRIES,
  type NodeSessionBinding, type Capability, type SessionInput, type SessionSetModel, type SessionControl, type SessionResume, type SessionClose,
  type LaneSeed, type SkillsList, type SkillInfo, type SkillsListResult, type NodeCommand, type NodeResult,
  type ProcessRun, type FsList, type FsListResult, type FsRead, type FsReadResult, type FsWrite, type FsWriteResult, type DirectoryEntry,
} from "./node-methods.js";
export {
  serverMethods, acknowledgedResult, MAX_SESSION_EVENT_CHARS, toNodeCredential, reinsToolNames,
  type SessionStarted, type SessionSettled, type SessionEventReport,
  type AttachmentStore, type AttachmentChunk, type StoredAttachment, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult,
  type ProjectCreateTask, type ProjectCreateTaskResult, type NodeCredential, type ServerCredential, type CredentialInfo,
  type StorageRead, type StorageReadResult, type StorageCommit, type StorageCommitResult, type StorageEntry, type NewStorageEntry,
  type StreamData, type StreamEnd, type CreateTaskInput, type ReinsToolCalls,
} from "./server-methods.js";
export {
  sessionModel, sessionRuntime, type SessionRuntime, MAX_SYSTEM_PROMPT_CHARS, promptContent, imageReference, streamId, type ProcessExit,
  MAX_ATTACHMENT_BYTES, MAX_PROMPT_BLOCKS, MAX_PROMPT_TEXT, ATTACHMENT_CHUNK_BYTES, ATTACHMENT_IMAGE_MIME_TYPES, STREAM_CHUNK_BYTES, MAX_STREAM_CHUNK_CHARS, MAX_PROCESS_STDERR_CHARS,
} from "./fields.js";
export { type StreamSource, type OpenStreamSource } from "./streams.js";
export { serveMethods, methodClient, type MethodInput, type MethodCallOptions, type MethodResult, type RequestMethod } from "./method-table.js";
export { createNodeConnection, protocolVersion, methods, helloParams, readyResult, MAX_LIVE_SESSIONS, type NodeCommandHandlers, type Hello, type Ready } from "./node-connection.js";
export {
  createRpcPeer, RpcFailure, NotConnected, systemTimers, MAX_ERROR_MESSAGE,
  METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR, NEGOTIATION_FAILED, BUSY, UNAUTHORIZED, FRAME_TOO_LARGE,
  type WireSocket, type LinkSocket,
} from "./rpc.js";
export { ndjsonSocketHandler, defaultLocalNodeSocketPath, HELLO_TIMEOUT_MS, LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, MAX_UNIX_SOCKET_PATH_BYTES, type NdjsonSocket, type LinkOptions } from "./local-socket.js";
export { APPLICATION_ERROR, nodeError, nodeErrorCode, NodeRejection, DeliveryDeferred, serverCallRejection, type NodeError } from "./errors.js";
export { finalReply, contentImages, mapContentImages, type AgentRuntimeEvent, type AssistantStreamEvent, type ConversationEntry, type FinalReply, type ImageReferenceBlock, type InlineImageBlock, type PromptBlock, type RuntimeContentBlock, type RuntimeMessage, type RuntimeOperationError } from "./session-events.js";
