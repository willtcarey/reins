import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { RuntimeContentBlock, RuntimeMessage } from "../../messages-store.js";
import { toSDKToolName, toSDKToolArgs, toSDKStopReason } from "./mappings.js";
import { toClaudeSdkImageBlock, toClaudeSdkUserContentBlock } from "./sdk-content-blocks.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SessionEntryContext = {
  sessionId: string;
  cwd: string;
};

type UserMessageContent = string | Array<ContentBlockParam | RuntimeContentBlock | Record<string, unknown>> | undefined;

/** Narrowed entry type so we can access message.id without `as` casts. */
type TypedEntry = SessionStoreEntry & {
  message: { id?: string; [k: string]: unknown };
};

/**
 * Convert persisted RuntimeMessages into SessionStoreEntry[] for the
 * Claude Agent SDK's SessionStore.load() method.
 */
export function toSessionStoreEntries(
  messages: RuntimeMessage[],
  context: SessionEntryContext,
): SessionStoreEntry[] {
  const out: TypedEntry[] = [];
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
      const toolResults: RuntimeMessage[] = [];
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
    if (!entry.message.id) {
      entry.message.id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

function makeUserEntry(content: UserMessageContent): TypedEntry {
  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
  };
}

function buildUserEntry(msg: RuntimeMessage): TypedEntry {
  return makeUserEntry(translateUserContentToSDKContent(msg.content));
}

function buildAssistantEntry(msgs: RuntimeMessage[]): TypedEntry | null {
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

function buildToolResultEntry(results: RuntimeMessage[]): TypedEntry {
  const content = results.map((r) => ({
    type: "tool_result" as const,
    tool_use_id: String(r.toolCallId),
    content: extractToolResultContent(r.content),
    is_error: Boolean(r.isError),
  }));

  return makeUserEntry(content);
}

function buildCompactionEntry(msg: RuntimeMessage): TypedEntry {
  return makeUserEntry(msg.summary ?? "");
}

// ---------------------------------------------------------------------------
// Content block transforms
// ---------------------------------------------------------------------------

function translateUserContentToSDKContent(content: RuntimeMessage["content"]): UserMessageContent {
  if (!content) return undefined;

  return content.map((block) => {
    switch (block.type) {
      case "text":
        return toClaudeSdkUserContentBlock(block);
      case "image":
        if ("data" in block) return toClaudeSdkUserContentBlock(block);
        return { type: "text", text: "[Image attachment missing]" };
      case "thinking":
      case "toolCall":
        return block;
    }
  });
}

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
    case "image": {
      if (!("data" in block)) return null;
      return toClaudeSdkImageBlock(block);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool result content extraction
// ---------------------------------------------------------------------------

/**
 * If content is an array with a single text block, return just the string.
 * Otherwise pass through.
 */
function extractToolResultContent(content: RuntimeMessage["content"]): string | RuntimeMessage["content"] {
  if (!Array.isArray(content)) return content;
  if (content.length !== 1) return content;

  const block = content[0];
  if (block.type !== "text") return content;

  return block.text;
}
