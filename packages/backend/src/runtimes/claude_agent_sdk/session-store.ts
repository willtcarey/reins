import type { SessionStore, SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeMessage, RuntimeContentBlock } from "../registry.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { loadMessagesForLLM } from "../../session-store.js";

// ---------------------------------------------------------------------------
// Constants — reverse of the maps in events.ts
// ---------------------------------------------------------------------------

const MCP_CUSTOM_TOOL_PREFIX = "mcp__custom-tools__";

const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
};

const CUSTOM_TOOL_NAMES = new Set(["create_task", "delegate", "search", "execute"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SessionEntryContext = {
  sessionId: string;
  cwd: string;
};

/**
 * Convert persisted AgentRuntimeMessages into SessionStoreEntry[] for the
 * Claude Agent SDK's SessionStore.load() method.
 */
export function toSessionStoreEntries(
  messages: AgentRuntimeMessage[],
  context: SessionEntryContext,
): SessionStoreEntry[] {
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
      // Each assistant message becomes its own entry. The SDK expects
      // thinking and tool_use as separate entries — merging them causes
      // API errors ("tool use concurrency issues").
      const entry = buildAssistantEntry([msg]);
      if (entry) out.push(entry);
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

  // Assign uuid/parentUuid chain and metadata so the SDK can resume.
  // The SDK requires message.id to properly reconstruct conversations
  // (it uses this to merge split assistant entries back together).
  let prevUuid: string | undefined;
  for (const entry of out) {
    const uuid = crypto.randomUUID();
    entry.uuid = uuid;
    if (prevUuid !== undefined) {
      entry.parentUuid = prevUuid;
    }
    prevUuid = uuid;
    entry.sessionId = context.sessionId;
    entry.cwd = context.cwd;
    entry.timestamp = new Date().toISOString();
    // SDK requires message.id on each entry
    const msg = entry.message as Record<string, unknown> | undefined;
    if (msg && !msg.id) {
      msg.id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    }
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

function buildAssistantEntry(msgs: AgentRuntimeMessage[]): SessionStoreEntry | null {
  const content = msgs.flatMap((m) =>
    Array.isArray(m.content) ? m.content.map(translateContentBlockToSDKBlock).filter((b) => b !== null) : [],
  );

  // If all content blocks were stripped (e.g. unsigned thinking), drop the entry
  if (content.length === 0) return null;

  // Use the last message's stopReason (e.g. tool_use or end_turn)
  const lastStop = msgs[msgs.length - 1].stopReason;

  return {
    type: "assistant",
    message: {
      role: "assistant",
      content,
      stop_reason: translateStopReason(lastStop),
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

/**
 * Translate a normalized content block back to SDK format.
 * Returns `null` for thinking blocks that should be stripped (no valid signature).
 */
function translateContentBlockToSDKBlock(block: RuntimeContentBlock): ContentBlockParam | null {
  switch (block.type) {
    case "toolCall": {
      const name = translateToolName(block.name);
      return {
        type: "tool_use",
        id: block.id,
        name,
        input: translateToolArgs(name, block.arguments),
      };
    }
    case "thinking": {
      // Our persisted format uses `thinkingSignature`; the SDK expects `signature`.
      if (typeof block.thinkingSignature !== "string") {
        // Old sessions without any signature — strip the block
        return null;
      }
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.thinkingSignature,
      };
    }
    case "text":
      // Structurally compatible with TextBlockParam
      return block;
  }
}

// ---------------------------------------------------------------------------
// Tool name / arg translation (reverse of events.ts)
// ---------------------------------------------------------------------------

function translateToolName(name: string): string {
  if (TOOL_NAME_MAP[name]) return TOOL_NAME_MAP[name];
  if (CUSTOM_TOOL_NAMES.has(name)) return MCP_CUSTOM_TOOL_PREFIX + name;
  return name;
}

/**
 * Reverse of normalizeToolArgs in events.ts.
 * Converts our camelCase/short arg names back to the SDK's snake_case names.
 */
function translateToolArgs(
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
// Stop reason translation
// ---------------------------------------------------------------------------

function translateStopReason(reason: string | undefined): string | undefined {
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
export function createSessionStore(cwd: string): SessionStore {
  return {
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const messages = loadMessagesForLLM(key.sessionId);
      if (messages.length === 0) return null;
      return toSessionStoreEntries(messages, { sessionId: key.sessionId, cwd });
    },

    async append(_key: SessionKey, _entries: SessionStoreEntry[]): Promise<void> {
      // No-op — the SDK writes its own JSONL files locally.
    },

    async listSubkeys(_key: { projectKey: string; sessionId: string }): Promise<string[]> {
      return [];
    },
  };
}
