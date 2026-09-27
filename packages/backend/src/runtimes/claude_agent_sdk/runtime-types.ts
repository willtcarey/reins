/**
 * Execution types of the dormant Claude SDK runtime. The server no longer executes sessions (they run
 * on nodes), so these moved here from the server's runtime registry; they exist only so this in-tree
 * implementation keeps compiling until it is rebuilt on AgentHarness.
 */
import type { TaskRow } from "../../task-store.js";
import type { ConversationEntry, RuntimeContentBlock, RuntimeMessage } from "../../messages-store.js";

type RuntimeCompactionEvent =
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; result?: { summary?: string }; aborted?: boolean; errorMessage?: string; willRetry?: boolean };

/** Streaming delta event for assistant messages. Consumers only read `type` + `delta`. */
type RuntimeAssistantDelta = {
  type: string;
  delta?: string;
  [key: string]: unknown;
};

export interface RuntimeOperationError {
  code?: string;
  message: string;
  details?: unknown;
}

export interface RuntimeToolResultPayload {
  content: RuntimeContentBlock[];
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export type AgentRuntimeEvent =
  | { type: "agent_start" }
  | {
    type: "agent_end";
    messages: RuntimeMessage[];
    runId?: string;
    status?: "completed" | "failed" | "aborted";
    error?: RuntimeOperationError;
  }
  | { type: "turn_start" }
  | { type: "turn_end"; message: RuntimeMessage; toolResults: RuntimeMessage[] }
  | { type: "message_start"; message: RuntimeMessage; streamId: string }
  | { type: "message_update"; message: RuntimeMessage; streamId: string; assistantMessageEvent: RuntimeAssistantDelta }
  | { type: "message_end"; message: RuntimeMessage; streamId: string; entryId?: string }
  | { type: "entry_added"; entry: ConversationEntry<RuntimeMessage> }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: RuntimeToolResultPayload; isError: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | RuntimeCompactionEvent;

export interface SetRuntimeModelParams {
  provider: string;
  modelId: string;
  thinkingLevel?: string | null;
}

export interface CreateAgentRuntimeParams {
  projectDir: string;
  sessionId: string;
  task: TaskRow | null;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  sessionTools?: { builtins: Array<"read" | "write" | "edit" | "bash"> };
  resume?: boolean;
}
