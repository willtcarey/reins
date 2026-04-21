import type { SessionStore, SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeMessage, RuntimeContentBlock } from "../registry.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { loadMessagesForLLM, appendMessages } from "../../session-store.js";
import { toSDKToolName, toSDKToolArgs, toSDKStopReason } from "./mappings.js";
import { transformClaudeSessionMessages } from "./events.js";

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
    const msg: Record<string, unknown> | undefined = entry.message;
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

  // Use the last message's stopReason (e.g. toolUse or endTurn)
  const lastStop = msgs[msgs.length - 1].stopReason;

  return {
    type: "assistant",
    message: {
      role: "assistant",
      content,
      stop_reason: toSDKStopReason(lastStop),
    },
  };
}

function buildToolResultEntry(results: AgentRuntimeMessage[]): SessionStoreEntry {
  const content = results.map((r) => ({
    type: "tool_result" as const,
    tool_use_id: String(r.toolCallId),
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
      const sdkName = toSDKToolName(block.name);
      return {
        type: "tool_use",
        id: block.id,
        name: sdkName,
        input: toSDKToolArgs(block.name, block.arguments),
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
// Tool result content extraction
// ---------------------------------------------------------------------------

/**
 * If content is an array with a single text block, return just the string.
 * Otherwise pass through.
 */
function extractToolResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  if (content.length === 1) {
    const block: unknown = content[0];
    if (block && typeof block === "object") {
      const obj: Record<string, unknown> = block;
      if (obj.type === "text") return obj.text;
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
 * - append() filters message entries, transforms them, and writes to SQLite.
 * - listSubkeys() returns [] — we don't use subagent transcripts.
 */
export function createSessionStore(sessionId: string, cwd: string): SessionStore {
  return {
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const messages = loadMessagesForLLM(key.sessionId);
      if (messages.length === 0) return null;
      return toSessionStoreEntries(messages, { sessionId: key.sessionId, cwd });
    },

    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      // Ignore subagent transcripts
      if (key.subpath) return;

      // Filter to message types that carry conversation content
      type MessageType = "user" | "assistant" | "system";
      const messageTypes = new Set<string>(["user", "assistant", "system"]);
      const messageEntries = entries.filter(
        (e): e is SessionStoreEntry & { type: MessageType } => messageTypes.has(e.type),
      );
      if (messageEntries.length === 0) return;

      // Transform SDK entries to AgentRuntimeMessages via the same path
      // used when reading session history from JSONL
      const runtimeMessages = transformClaudeSessionMessages(
        messageEntries.map((e) => ({
          type: e.type,
          uuid: e.uuid ?? "",
          session_id: sessionId,
          message: e.message,
          parent_tool_use_id: null,
        })),
      );
      if (runtimeMessages.length === 0) return;

      appendMessages(sessionId, runtimeMessages);
    },

    async listSubkeys(_key: { projectKey: string; sessionId: string }): Promise<string[]> {
      return [];
    },
  };
}
