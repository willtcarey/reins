import {
  BACKGROUND_CONTEXT,
  branchTip,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  estimateContextTokens,
  type AgentMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { ClientPromptContent } from "../messages-store.js";
import { getDb } from "../db.js";
import { PiStorageAdapter } from "../pi-storage.js";

export type ContextUsageMeasurement = "exact" | "estimated";

export interface SessionContextSnapshot {
  usedTokens: number;
  contextWindow: number;
  compactionThresholdTokens: number;
  utilization: number;
  measurement: ContextUsageMeasurement;
}

type ContextModel = {
  contextWindow: number;
  reserveTokens: number;
};

/** Normalize all live and restored context values through one client-facing shape. */
export function createSessionContextSnapshot(
  usedTokens: number,
  measurement: ContextUsageMeasurement,
  model: ContextModel,
): SessionContextSnapshot {
  return {
    usedTokens,
    contextWindow: model.contextWindow,
    compactionThresholdTokens: Math.max(0, model.contextWindow - model.reserveTokens),
    utilization: model.contextWindow <= 0 ? 0 : usedTokens / model.contextWindow,
    measurement,
  };
}

type StoredContextMessage = AgentMessage | {
  role: "reinsInput";
  content: ClientPromptContent;
  timestamp: number;
};

function normalizeMessage(message: StoredContextMessage): AgentMessage | null {
  if (message.role === "assistant" && ["aborted", "error", "deferred"].includes(message.stopReason)) {
    return null;
  }
  if (message.role !== "reinsInput") return message;

  const normalized: AgentMessage = {
    role: "user",
    content: message.content.map((block) => block.type === "text"
      ? block
      : { type: "image", data: "", mimeType: block.mimeType }),
    timestamp: message.timestamp,
  };
  return normalized;
}

function messagesForEntry(entry: Entry): AgentMessage[] {
  if (entry.type === "message") {
    const message = normalizeMessage(entry.message);
    return message ? [message] : [];
  }
  if (entry.type === "compaction") {
    return [
      createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
      ...entry.retainedTail.flatMap((message) => normalizeMessage(message) ?? []),
    ];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
  }
  return [];
}

function currentContext(entries: Entry[]): AgentMessage[] {
  const latestCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
  const activeEntries = latestCompaction < 0 ? entries : entries.slice(latestCompaction);
  return activeEntries.flatMap(messagesForEntry);
}

/** Load the canonical main branch through AgentHarness's storage contract. */
async function loadActivePiEntries(sessionId: string): Promise<Entry[]> {
  const storage = new PiStorageAdapter(getDb(), sessionId);
  const tip = await storage.getValue(branchTip("main"), BACKGROUND_CONTEXT);
  if (!tip || tip.value === null) return [];

  return storage.scanBranch({ start: tip.value, order: "oldestFirst" }, BACKGROUND_CONTEXT);
}

/** Build current occupancy from Pi's canonical active context, never cumulative session usage. */
export async function buildSessionContextSnapshot(
  sessionId: string,
  model: ContextModel,
): Promise<SessionContextSnapshot> {
  const messages = currentContext(await loadActivePiEntries(sessionId));
  if (messages.length === 0) return createSessionContextSnapshot(0, "exact", model);

  const estimate = estimateContextTokens(messages);
  const measurement = estimate.lastUsageIndex === messages.length - 1 ? "exact" : "estimated";
  return createSessionContextSnapshot(estimate.tokens, measurement, model);
}
