import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeMessage, RuntimeContentBlock } from "../registry.js";
import { isRecord, toRecord } from "./type-guards.js";
import {
  normalizeToolName,
  normalizeToolArgs,
  normalizeStopReason,
} from "./mappings.js";

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export function normalizeClaudeToolName(name: string | undefined | null): string {
  if (!name) return "";
  return normalizeToolName(name);
}

export function transformClaudeSessionMessages(messages: SessionMessage[]): AgentRuntimeMessage[] {
  const out: AgentRuntimeMessage[] = [];

  for (const entry of messages) {
    if (entry.type === "assistant") {
      const message = toRecord(entry.message);
      out.push({
        role: "assistant",
        content: mapAssistantContent(message.content),
        stopReason: mapStopReason(typeof message.stop_reason === "string" ? message.stop_reason : undefined),
        timestamp: nowTs(),
      });
      continue;
    }

    if (entry.type === "user") {
      const message = toRecord(entry.message);

      // SDK compaction: the compacted history summary is stored as a user
      // message with plain string content. Reins always sends array content
      // via buildUserMessage(), so string content reliably indicates an
      // SDK-side compaction boundary.
      if (typeof message.content === "string") {
        const summary = message.content;
        out.push({
          role: "compactionSummary",
          summary,
          content: summary,
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
      // The compact_boundary is a structural marker — the actual summary
      // lives in the preceding user message with string content. Only emit
      // a compactionSummary here if we haven't already added one.
      const raw = toRecord(entry);
      if (raw.subtype === "compact_boundary" || raw.compact_metadata) {
        const lastOut = out[out.length - 1];
        if (!lastOut || lastOut.role !== "compactionSummary") {
          out.push({
            role: "compactionSummary",
            summary: "",
            content: "",
            timestamp: nowTs(),
          });
        }
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
  return normalizeStopReason(stopReason);
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
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    }
  }

  if (out.length === 0) out.push({ type: "text", text: "" });
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers — session message transform
// ---------------------------------------------------------------------------

function mapAssistantContent(content: unknown): RuntimeContentBlock[] {
  if (!Array.isArray(content)) return [];

  const out: RuntimeContentBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === "text") {
      out.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
      continue;
    }

    if (block.type === "thinking") {
      out.push({
        type: "thinking",
        thinking: typeof block.thinking === "string" ? block.thinking : "",
        ...(typeof block.signature === "string" ? { thinkingSignature: block.signature } : {}),
      });
      continue;
    }

    if (block.type === "tool_use") {
      const toolName = normalizeClaudeToolName(typeof block.name === "string" ? block.name : "tool");
      out.push({
        type: "toolCall",
        id: typeof block.id === "string" ? block.id : String(block.id ?? ""),
        name: toolName,
        arguments: normalizeToolArgs(toolName, toRecord(block.input)),
      });
    }
  }

  return out;
}

function mapUserContent(content: unknown): RuntimeContentBlock[] {
  if (typeof content === "string") return [{ type: "text" as const, text: content }];
  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => ({ type: "text" as const, text: String(block.text ?? "") }));
}

function mapToolResultBlocks(content: unknown): AgentRuntimeMessage[] {
  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "tool_result")
    .map((block) => ({
      role: "toolResult",
      toolCallId: String(block.tool_use_id ?? ""),
      toolName: "tool",
      content: toTextContent(block.content),
      isError: Boolean(block.is_error),
      timestamp: nowTs(),
    } satisfies AgentRuntimeMessage));
}
