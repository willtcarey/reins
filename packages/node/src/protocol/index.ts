/** `@reins/node/protocol`: the node↔server wire protocol for the server side of the link. The package
 * entry point, so it re-exports from the protocol modules (lint exempts this file). */
export { createNodeConnection, type NodeCommandHandlers } from "./connection.js";
export { createRpcPeer, RpcFailure, systemTimers, type WireSocket } from "./peer.js";
export { ndjsonSocketHandler, type NdjsonSocket } from "./ndjson.js";
export { defaultLocalNodeSocketPath, LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, MAX_UNIX_SOCKET_PATH_BYTES, type LinkOptions } from "./local-link.js";
export { APPLICATION_ERROR, nodeError, NodeRejection, type NodeError } from "./errors.js";
export {
  methods, protocolVersion, capability, helloParams, readyResult, provisionResult,
  sessionInputResult, sessionSetModelResult, sessionAbortResult, sessionResumeResult, sessionHydrateResult, sessionDeleteResult,
  sessionCommittedParams, sessionCommittedResult, sessionStartedParams, sessionSettledParams, sessionEventParams, acknowledgedResult,
  sessionSnapshotParams, sessionSnapshotResult, attachmentFetchParams, attachmentFetchResult, attachmentStoreParams, attachmentStoreResult,
  scriptExecuteParams, scriptExecuteResult, scriptCancelParams, scriptSearchParams, scriptSearchResult, projectCreateTaskParams, projectCreateTaskResult,
  credentialsParams, credentialResult, credentialsListParams, credentialsListResult, toNodeCredential,
  MAX_ATTACHMENT_BYTES, ATTACHMENT_CHUNK_BYTES, ATTACHMENT_IMAGE_MIME_TYPES,
  type Capability, type Ready, type Provision, type SessionInput, type SessionSetModel, type SessionControl, type SessionHydrate, type SessionDelete,
  type SessionCommitted, type SessionStarted, type SessionSettled, type SessionEvent, type SessionEventReport, type SessionSnapshot,
  type StoredAttachment, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult,
  type ProjectCreateTask, type ProjectCreateTaskResult, type NodeCredential, type CredentialInfo,
} from "./schema.js";
