import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeMessage } from "../registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_CUSTOM_TOOL_PREFIX = "mcp__custom-tools__";

const BUILTIN_TOOL_NAME_MAP: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
};

export const COMPACTION_NOTICE = "*Claude Code compacted and we don't have visibility into the summary.*";

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export function normalizeClaudeToolName(name: string | undefined | null): string {
  if (!name) return "";
  if (name.startsWith(MCP_CUSTOM_TOOL_PREFIX)) {
    return name.slice(MCP_CUSTOM_TOOL_PREFIX.length);
  }
  return BUILTIN_TOOL_NAME_MAP[name] ?? name;
}

export function transformClaudeSessionMessages(messages: SessionMessage[]): AgentRuntimeMessage[] {
  const out: AgentRuntimeMessage[] = [];

  for (const entry of messages) {
    if (entry.type === "assistant") {
      const message = (entry.message ?? {}) as Record<string, unknown>;
      out.push({
        role: "assistant",
        content: mapAssistantContent(message.content),
        stopReason: mapStopReason(message.stop_reason as string | null | undefined),
        timestamp: nowTs(),
      });
      continue;
    }

    if (entry.type === "user") {
      const message = (entry.message ?? {}) as Record<string, unknown>;

      // SDK compaction: the compacted history summary is stored as a user
      // message with plain string content. Reins always sends array content
      // via buildUserMessage(), so string content reliably indicates an
      // SDK-side compaction boundary.
      if (typeof message.content === "string") {
        out.push({
          role: "compactionSummary",
          summary: COMPACTION_NOTICE,
          content: COMPACTION_NOTICE,
          timestamp: nowTs(),
        });
        continue;
      }

      const userContent = mapUserContent(message.content);
      if (userContent.length > 0) {
        out.push({
          role: "user",
          content: userContent,
          timestamp: nowTs(),
        });
      }
      out.push(...mapToolResultBlocks(message.content));
      continue;
    }

    if (entry.type === "system") {
      // SessionMessage doesn't expose `subtype` — detect compact_boundary
      // via the presence of `compact_metadata` on the raw entry.
      const raw = entry as Record<string, unknown>;
      if (raw.subtype === "compact_boundary" || raw.compact_metadata) {
        out.push({
          role: "compactionSummary",
          summary: COMPACTION_NOTICE,
          content: COMPACTION_NOTICE,
          timestamp: nowTs(),
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers — exported for stream-processor.ts
// ---------------------------------------------------------------------------

export function nowTs() {
  return Date.now();
}

export function mapStopReason(stopReason: string | null | undefined): string | undefined {
  if (!stopReason) return undefined;
  if (stopReason === "tool_use") return "toolUse";
  return stopReason;
}

/**
 * Normalize SDK tool arg names to the frontend-expected names.
 *
 * The Claude SDK built-in tools use snake_case arg names (file_path,
 * old_string, new_string) while the Reins frontend expects shortened
 * or camelCase names (path, oldText, newText).
 */
export function normalizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const out = { ...args };
    if ("file_path" in out) {
      out.path = out.file_path;
      delete out.file_path;
    }
    if (toolName === "edit") {
      if ("old_string" in out) {
        out.oldText = out.old_string;
        delete out.old_string;
      }
      if ("new_string" in out) {
        out.newText = out.new_string;
        delete out.new_string;
      }
    }
    return out;
  }
  return args;
}

export function toTextContent(content: unknown): { type: "text"; text: string }[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const out: { type: "text"; text: string }[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      out.push({ type: "text", text: typed.text });
    }
  }

  if (out.length === 0) out.push({ type: "text", text: "" });
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers — session message transform
// ---------------------------------------------------------------------------

function mapAssistantContent(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];

  const out: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;

    if (typed.type === "text") {
      out.push({ type: "text", text: typeof typed.text === "string" ? typed.text : "" });
      continue;
    }

    if (typed.type === "thinking") {
      out.push({ type: "thinking", thinking: typeof typed.thinking === "string" ? typed.thinking : "" });
      continue;
    }

    if (typed.type === "tool_use") {
      const toolName = normalizeClaudeToolName(typeof typed.name === "string" ? typed.name : "tool");
      out.push({
        type: "toolCall",
        id: typed.id,
        name: toolName,
        arguments: normalizeToolArgs(toolName, (typed.input ?? {}) as Record<string, unknown>),
      });
    }
  }

  return out;
}

function mapUserContent(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object" && (block as Record<string, unknown>).type === "text")
    .map((block) => ({ type: "text", text: String(block.text ?? "") }));
}

function mapToolResultBlocks(content: unknown): AgentRuntimeMessage[] {
  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result")
    .map((block) => ({
      role: "toolResult",
      toolCallId: String(block.tool_use_id ?? ""),
      toolName: "tool",
      content: toTextContent(block.content),
      isError: Boolean(block.is_error),
      timestamp: nowTs(),
    } satisfies AgentRuntimeMessage));
}
