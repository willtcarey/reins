/* eslint-disable typescript-eslint/consistent-type-assertions -- canonical JSON includes the supported Reins custom message */
import type { Database } from "bun:sqlite";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  estimateContextTokens,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  readActiveBranchEntries,
  type StoredCanonicalEntry,
  type StoredEntryEnvelope,
} from "../messages-store.js";

export type ContextUsageMeasurement = "exact" | "estimated" | "unknown";

export interface SessionContextSnapshot {
  usedTokens: number | null;
  contextWindow: number;
  compactionThresholdTokens: number;
  utilization: number | null;
  measurement: ContextUsageMeasurement;
}

/** Normalize all live and restored context values through one client-facing shape. */
export function createSessionContextSnapshot(
  usedTokens: number | null,
  measurement: ContextUsageMeasurement,
  model: { contextWindow: number; reserveTokens: number },
): SessionContextSnapshot {
  return {
    usedTokens,
    contextWindow: model.contextWindow,
    compactionThresholdTokens: Math.max(0, model.contextWindow - model.reserveTokens),
    utilization: usedTokens === null || model.contextWindow <= 0 ? null : usedTokens / model.contextWindow,
    measurement,
  };
}

export function unknownSessionContextSnapshot(
  snapshot: Pick<SessionContextSnapshot, "contextWindow" | "compactionThresholdTokens">,
): SessionContextSnapshot {
  return {
    ...snapshot,
    usedTokens: null,
    utilization: null,
    measurement: "unknown",
  };
}

function projectContextMessage(message: unknown): AgentMessage | null {
  const stored = message as {
    role: string;
    content?: unknown;
    timestamp?: number;
    stopReason?: string;
  };
  if (stored.role === "reinsInput") {
    return {
      role: "user",
      content: stored.content ?? [],
      timestamp: stored.timestamp ?? 0,
    } as AgentMessage;
  }
  if (
    stored.role === "assistant"
    && (stored.stopReason === "aborted" || stored.stopReason === "error" || stored.stopReason === "deferred")
  ) return null;
  return message as AgentMessage;
}

function contextMessages(entry: StoredCanonicalEntry): AgentMessage[] {
  const envelope: StoredEntryEnvelope = entry.envelope;
  if (envelope.type === "message") {
    const message = projectContextMessage(envelope.message);
    return message ? [message] : [];
  }
  if (envelope.type === "compaction") {
    return [
      createCompactionSummaryMessage(envelope.summary, envelope.tokensBefore, envelope.timestamp),
      ...envelope.retainedTail.flatMap((stored) => {
        const message = projectContextMessage(stored);
        return message ? [message] : [];
      }),
    ];
  }
  if (envelope.type === "branch_summary" && envelope.summary) {
    return [createBranchSummaryMessage(envelope.summary, envelope.fromId, envelope.timestamp)];
  }
  return [];
}

/** Build current occupancy from the canonical active context, never cumulative session usage. */
export function buildSessionContextSnapshot(
  db: Database,
  sessionId: string,
  model: { contextWindow: number; reserveTokens: number },
): SessionContextSnapshot {
  const entries = readActiveBranchEntries(db, sessionId) ?? [];
  const latestCompaction = entries.findLastIndex((entry) => entry.envelope.type === "compaction");
  const contextEntries = latestCompaction < 0 ? entries : entries.slice(latestCompaction);
  const messages = contextEntries.flatMap(contextMessages);
  if (messages.length === 0) return createSessionContextSnapshot(0, "exact", model);

  const estimate = estimateContextTokens(messages);
  const measurement = estimate.lastUsageIndex === messages.length - 1 ? "exact" : "estimated";
  return createSessionContextSnapshot(estimate.tokens, measurement, model);
}
