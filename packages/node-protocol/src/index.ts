/** `@reins/node-protocol`: everything about talking over the server↔node link, used by both sides —
 * the server's durable command vocabulary (`contract.ts`), the wire schemas, method names and
 * capabilities (`schema.ts`), node error codes, the runtime event shapes `session.event` carries, the
 * Reins tool call surface, and the RPC plumbing both ends run (JSON-RPC peer, NDJSON Unix-socket framing,
 * local-link constants, the node end of a connection). Imports only `zod` (and runtime builtins). Test
 * doubles live in `@reins/node-protocol/testing`. The package entry point, so it re-exports from its
 * modules (lint exempts this file). */
export {
  sessionConfiguration, promptContent, nodeCommand, nodeResult, nodeErrorCode, deliveryPolicy,
  MAX_ATTACHMENT_BYTES, MAX_PROMPT_BLOCKS, MAX_PROMPT_TEXT,
  type NodeCommand, type NodeResult, type SessionConfiguration,
} from "./contract.js";
export {
  methods, protocolVersion, capability, helloParams, readyResult, provisionResult,
  sessionInputResult, sessionSetModelResult, sessionAbortResult, sessionResumeResult, sessionCloseResult, sessionHydrateResult, sessionDeleteResult, MAX_LIVE_SESSIONS,
  sessionCommittedParams, sessionCommittedResult, sessionStartedParams, sessionSettledParams, sessionEventParams, MAX_SESSION_EVENT_CHARS, imageReference, acknowledgedResult,
  sessionSnapshotParams, sessionSnapshotResult, attachmentFetchParams, attachmentFetchResult, attachmentStoreParams, attachmentStoreResult,
  scriptExecuteParams, scriptExecuteResult, scriptCancelParams, scriptSearchParams, scriptSearchResult, projectCreateTaskParams, projectCreateTaskResult,
  credentialsParams, credentialResult, credentialsListParams, credentialsListResult, toNodeCredential,
  skillsListParams, skillsListResult, MAX_LISTED_SKILLS,
  storageReadParams, storageReadResult, storageCommitParams, storageCommitResult,
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_IMAGE_MIME_TYPES,
  type Capability, type Ready, type Provision, type SessionInput, type SessionSetModel, type SessionControl, type SessionResume, type SessionClose, type SessionTask, type LaneSeed, type SessionHydrate, type SessionDelete,
  type SessionCommitted, type SessionStarted, type SessionSettled, type SessionEventReport, type SessionSnapshot, type SnapshotSummary,
  type AttachmentStore, type AttachmentChunk, type StoredAttachment, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult,
  type ProjectCreateTask, type ProjectCreateTaskResult, type NodeCredential, type ServerCredential, type CredentialInfo, type NodeSessionBinding,
  type SkillsList, type SkillInfo, type SkillsListResult,
  type StorageRead, type StorageReadResult, type StorageCommit, type StorageCommitResult, type StorageEntry, type NewStorageEntry,
} from "./schema.js";
export { finalReply, type AgentRuntimeEvent, type AssistantStreamEvent, type ConversationEntry, type FinalReply, type ImageReferenceBlock, type InlineImageBlock, type PromptBlock, type RuntimeContentBlock, type RuntimeMessage, type RuntimeOperationError } from "./events.js";
export { contentImages, mapContentImages } from "./event-images.js";
export { reinsToolNames, type CreateTaskInput, type ReinsToolCalls } from "./tools.js";
export { APPLICATION_ERROR, nodeError, NodeRejection, serverCallRejection, type NodeError } from "./errors.js";
export { createRpcPeer, RpcFailure, systemTimers, FRAME_TOO_LARGE, MAX_ERROR_MESSAGE, type WireSocket } from "./peer.js";
export { createNodeConnection, type NodeCommandHandlers } from "./connection.js";
export { ndjsonSocketHandler, type NdjsonSocket } from "./ndjson.js";
export { defaultLocalNodeSocketPath, HELLO_TIMEOUT_MS, LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, MAX_UNIX_SOCKET_PATH_BYTES, type LinkOptions } from "./local-link.js";
