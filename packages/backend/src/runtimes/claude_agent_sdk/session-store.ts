import type { SessionStore, SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeMessage } from "../registry.js";
import { loadMessagesForLLM } from "../../session-store.js";

// ---------------------------------------------------------------------------
// Constants — reverse of the maps in events.ts
// ---------------------------------------------------------------------------

const MCP_CUSTOM_TOOL_PREFIX = "mcp__custom-tools__";

const DENORM_TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
};

const CUSTOM_TOOL_NAMES = new Set(["create_task", "delegate", "search", "execute"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert persisted AgentRuntimeMessages into SessionStoreEntry[] for the
 * Claude Agent SDK's SessionStore.load() method.
 */
export function toSessionStoreEntries(messages: AgentRuntimeMessage[]): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "user") {
      out.push(buildUserEntry(msg));
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      out.push(buildAssistantEntry(msg));
      i++;
      continue;
    }

    if (msg.role === "toolResult") {
      // Accumulate consecutive toolResult messages into one user entry
      const toolResults: AgentRuntimeMessage[] = [];
      while (i < messages.length && messages[i].role === "toolResult") {
        toolResults.push(messages[i]);
        i++;
      }
      out.push(buildToolResultEntry(toolResults));
      continue;
    }

    if (msg.role === "compactionSummary") {
      out.push(buildCompactionEntry(msg));
      i++;
      continue;
    }

    // Unknown roles: skip
    i++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

function buildUserEntry(msg: AgentRuntimeMessage): SessionStoreEntry {
  return {
    type: "user",
    message: {
      role: "user",
      content: msg.content,
    },
  };
}

function buildAssistantEntry(msg: AgentRuntimeMessage): SessionStoreEntry {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: Array.isArray(msg.content) ? msg.content.map(denormContentBlock) : [],
      stop_reason: denormStopReason(msg.stopReason),
    },
  };
}

function buildToolResultEntry(results: AgentRuntimeMessage[]): SessionStoreEntry {
  const content = results.map((r) => ({
    type: "tool_result" as const,
    tool_use_id: r.toolCallId as string,
    content: extractToolResultContent(r.content),
    is_error: Boolean(r.isError),
  }));

  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
  };
}

function buildCompactionEntry(msg: AgentRuntimeMessage): SessionStoreEntry {
  const text = msg.summary ?? (typeof msg.content === "string" ? msg.content : "");
  return {
    type: "user",
    message: {
      role: "user",
      content: text,
    },
  };
}

// ---------------------------------------------------------------------------
// Content block transforms
// ---------------------------------------------------------------------------

function denormContentBlock(block: unknown): unknown {
  if (!block || typeof block !== "object") return block;
  const b = block as Record<string, unknown>;

  if (b.type === "toolCall") {
    const name = denormToolName(b.name as string);
    return {
      type: "tool_use",
      id: b.id,
      name,
      input: denormToolArgs(name, b.arguments as Record<string, unknown> | undefined),
    };
  }

  // thinking and text blocks pass through as-is
  return block;
}

// ---------------------------------------------------------------------------
// Tool name / arg denormalization (reverse of events.ts)
// ---------------------------------------------------------------------------

function denormToolName(name: string): string {
  if (DENORM_TOOL_NAME_MAP[name]) return DENORM_TOOL_NAME_MAP[name];
  if (CUSTOM_TOOL_NAMES.has(name)) return MCP_CUSTOM_TOOL_PREFIX + name;
  return name;
}

/**
 * Reverse of normalizeToolArgs in events.ts.
 * Converts our camelCase/short arg names back to the SDK's snake_case names.
 */
function denormToolArgs(
  sdkToolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!args) return {};

  if (sdkToolName === "Read" || sdkToolName === "Write" || sdkToolName === "Edit") {
    const out = { ...args };
    if ("path" in out) {
      out.file_path = out.path;
      delete out.path;
    }
    if (sdkToolName === "Edit") {
      if ("oldText" in out) {
        out.old_string = out.oldText;
        delete out.oldText;
      }
      if ("newText" in out) {
        out.new_string = out.newText;
        delete out.newText;
      }
    }
    return out;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Stop reason denormalization
// ---------------------------------------------------------------------------

function denormStopReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  if (reason === "toolUse") return "tool_use";
  if (reason === "endTurn") return "end_turn";
  return reason;
}

// ---------------------------------------------------------------------------
// Tool result content extraction
// ---------------------------------------------------------------------------

/**
 * If content is an array with a single text block, return just the string.
 * Otherwise pass through.
 */
function extractToolResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  if (content.length === 1) {
    const block = content[0];
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      return (block as Record<string, unknown>).text;
    }
  }
  return content;
}

// ---------------------------------------------------------------------------
// SessionStore factory
// ---------------------------------------------------------------------------

/**
 * Create a SessionStore backed by our SQLite database.
 *
 * - load() translates persisted messages into SessionStoreEntry[] for resume.
 * - append() is a no-op — the SDK's local JSONL files handle bookkeeping.
 * - listSubkeys() returns [] — we don't use subagent transcripts.
 */
export function createSessionStore(): SessionStore {
  return {
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const messages = loadMessagesForLLM(key.sessionId);
      if (messages.length === 0) return null;
      return toSessionStoreEntries(messages);
    },

    async append(_key: SessionKey, _entries: SessionStoreEntry[]): Promise<void> {
      // No-op — the SDK writes its own JSONL files locally.
    },

    async listSubkeys(_key: { projectKey: string; sessionId: string }): Promise<string[]> {
      return [];
    },
  };
}
