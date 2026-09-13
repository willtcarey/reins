import { describe, test, expect, beforeEach } from "bun:test";
import retryReplacementFixture from "./fixtures/pi-codex-retry-replacement.json";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import { getDb } from "../db.js";
import {
  appendMessages,
  attachStoredMessageMetadata,
  loadMessagePage,
  loadMessages,
  loadMessagesForLLM,
  listSessionEntries,
  parseDisplayCursor,
  persistMessages,
  type PersistedMessage,
  type RuntimeMessage,
} from "../messages-store.js";

interface FixtureMessage {
  role: string;
  content: ({ text: string } | { id: string; name: string; arguments: Record<string, unknown> })[];
  [key: string]: unknown;
}

function fixtureSnapshot(messages: FixtureMessage[]): RuntimeMessage[] {
  return messages.map(({ content, ...message }) => ({
    ...message,
    content: content.map((block) => (
      "text" in block
        ? { type: "text", text: block.text }
        : { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }
    )),
  }));
}

const failedRetrySnapshot = fixtureSnapshot(retryReplacementFixture.failedSnapshot);
const successfulRetrySnapshot = fixtureSnapshot(retryReplacementFixture.successfulSnapshot);

let projectId: number;

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function toolCallIdsMatch(messages: any[]): boolean {
  const calls = messages.flatMap((message) => (
    Array.isArray(message.content)
      ? message.content.filter((block: any) => block.type === "toolCall").map((block: any) => block.id)
      : []
  ));
  const results = messages
    .filter((message) => message.role === "toolResult")
    .map((message) => message.toolCallId);
  return calls.length === results.length && calls.every((id, index) => id === results[index]);
}

function messageText(message: any): string | undefined {
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n");
  }
  return message.summary;
}

describe("messages-store", () => {
  useTestDb();

  beforeEach(() => {
    const project = createProject("Test Project", "/tmp/test-project");
    projectId = project.id;
  });

  describe("persistMessages", () => {
    test("inserts messages with correct seq ordering", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const msgs: RuntimeMessage[] = [
        { role: "user", content: textContent("Hello") },
        { role: "assistant", content: textContent("Hi") },
      ];
      persistMessages("sess-1", msgs);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(2);
      expect(loaded[0].role).toBe("user");
      expect(loaded[1].role).toBe("assistant");
    });

    test("is idempotent — re-calling with same messages inserts nothing new", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const msgs: RuntimeMessage[] = [
        { role: "user", content: textContent("Hello") },
      ];
      persistMessages("sess-1", msgs);
      persistMessages("sess-1", msgs);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(1);
    });

    test("stores linear ancestry across snapshot growth, append, rewrite, truncation, and compaction", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const initial: RuntimeMessage[] = [
        { role: "user", content: textContent("Hello") },
        { role: "assistant", content: textContent("Draft") },
      ];
      persistMessages("sess-1", initial);
      const initialPage = loadMessagePage("sess-1", 10);

      appendMessages("sess-1", [{ role: "user", content: textContent("Follow-up") }]);
      persistMessages("sess-1", [
        initial[0],
        { role: "assistant", content: textContent("Final") },
      ]);
      appendMessages("sess-1", [{ role: "user", content: textContent("Replacement follow-up") }]);
      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary" },
        { role: "assistant", content: textContent("Retained") },
      ]);

      const rows = getDb().query<{
        id: number;
        seq: number;
        parent_id: number | null;
        harness_id: string | null;
      }, [string]>(
        "SELECT id, seq, parent_id, harness_id FROM session_messages WHERE session_id = ? ORDER BY seq",
      ).all("sess-1");
      expect(rows.map((row) => ({ seq: row.seq, parent_id: row.parent_id, harness_id: row.harness_id }))).toEqual([
        { seq: 0, parent_id: null, harness_id: null },
        { seq: 1, parent_id: rows[0].id, harness_id: null },
        { seq: 2, parent_id: rows[1].id, harness_id: null },
        { seq: 3, parent_id: rows[2].id, harness_id: null },
        { seq: 4, parent_id: rows[3].id, harness_id: null },
      ]);
      expect(String(rows[0].id)).toBe(initialPage.items[0].id);
      expect(String(rows[1].id)).toBe(initialPage.items[1].id);
      expect(getDb().query("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    test("projects stored ancestry without deriving a predecessor", () => {
      createSession("sess-stored-parent", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-stored-parent", [
        { role: "user", content: textContent("Root") },
        { role: "assistant", content: textContent("Independent root") },
      ]);
      const secondId = loadMessagePage("sess-stored-parent", 10).items[1].id;
      getDb().query("UPDATE session_messages SET parent_id = NULL WHERE id = ?").run(secondId);

      expect(loadMessagePage("sess-stored-parent", 10).items[1].parentId).toBeNull();
    });

    test("reconciles the Codex retry replacement fixture without mismatched tool IDs", () => {
      createSession("sess-retry", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-retry", failedRetrySnapshot);
      const failedPage = loadMessagePage("sess-retry", 10);

      persistMessages("sess-retry", successfulRetrySnapshot);

      const persisted = loadMessages("sess-retry");
      const reconciledPage = loadMessagePage("sess-retry", 10);
      expect(toolCallIdsMatch(persisted)).toBe(true);
      expect(JSON.stringify(persisted)).not.toContain(retryReplacementFixture.failedToolCallId);
      expect(JSON.stringify(persisted)).toContain(retryReplacementFixture.retryToolCallId);
      expect(reconciledPage.items[1].id).toBe(failedPage.items[1].id);
      expect(reconciledPage.items[2].parentId).toBe(reconciledPage.items[1].id);
      expect(parseDisplayCursor("sess-retry", failedPage.pageInfo.endCursor!, "after")).toBe(1);
    });

    test("treats the latest complete snapshot as authoritative", () => {
      createSession("sess-authoritative", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-authoritative", [
        { role: "user", content: textContent("first") },
        { role: "assistant", content: textContent("old answer") },
        { role: "user", content: textContent("discard me") },
      ]);
      const originalPage = loadMessagePage("sess-authoritative", 10);

      const replacement: RuntimeMessage[] = [
        { role: "user", content: textContent("rewritten") },
        { role: "assistant", content: textContent("new answer") },
      ];
      persistMessages("sess-authoritative", replacement);

      expect(loadMessages("sess-authoritative")).toEqual(replacement);
      const replacedPage = loadMessagePage("sess-authoritative", 10);
      expect(replacedPage.items.map(({ id }) => id)).toEqual(
        originalPage.items.slice(0, 2).map(({ id }) => id),
      );
    });

  });

  describe("stored message metadata", () => {
    test("survives same-message snapshot updates and reopen projection without leaking to the model", () => {
      createSession("sess-metadata", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-metadata", [
        { role: "user", content: textContent("question"), timestamp: 1000, logicalId: "question-id" },
        { role: "assistant", content: textContent("draft"), stopReason: "toolUse", timestamp: 2000, logicalId: "answer-id" },
      ]);
      const assistantId = loadMessagePage("sess-metadata", 10).items[1].id;
      const notification = { sourceSessionId: "child-1", outcome: "completed" };
      attachStoredMessageMetadata("sess-metadata", assistantId, "session-orchestration", notification);
      attachStoredMessageMetadata("sess-metadata", assistantId, "audit", { reviewed: true });

      const reopenProjection = loadMessagesForLLM("sess-metadata");
      expect(reopenProjection).toEqual([
        { role: "user", content: textContent("question"), timestamp: 1000, logicalId: "question-id" },
        { role: "assistant", content: textContent("draft"), stopReason: "toolUse", timestamp: 2000, logicalId: "answer-id" },
      ]);
      persistMessages("sess-metadata", reopenProjection);
      persistMessages("sess-metadata", [
        { role: "user", content: textContent("question"), timestamp: 1000 },
        {
          role: "assistant",
          content: textContent("final"),
          stopReason: "stop",
          timestamp: 2000,
          logicalId: "answer-id",
          metadata: { marker: "runtime snapshots cannot overwrite application metadata" },
        },
      ]);

      const storedAssistant: PersistedMessage = {
        role: "assistant",
        content: textContent("final"),
        stopReason: "stop",
        timestamp: 2000,
        logicalId: "answer-id",
        metadata: {
          "session-orchestration": notification,
          audit: { reviewed: true },
        },
      };
      expect(loadMessages("sess-metadata")[1]).toEqual(storedAssistant);
      expect(loadMessagePage("sess-metadata", 10).items[1].message).toEqual(storedAssistant);
      expect(loadMessagesForLLM("sess-metadata")[1]).not.toHaveProperty("metadata");
    });

    test("requires stable logical identity for metadata attachment", () => {
      createSession("sess-metadata-unidentified", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-metadata-unidentified", [
        { role: "user", content: textContent("message without a normalized timestamp"), id: "vendor-id" },
      ]);
      const messageId = loadMessagePage("sess-metadata-unidentified", 10).items[0].id;

      expect(() => attachStoredMessageMetadata(
        "sess-metadata-unidentified",
        messageId,
        "marker",
        { value: true },
      )).toThrow();
      expect(loadMessages("sess-metadata-unidentified")[0]).not.toHaveProperty("metadata");
    });

    test("does not transfer metadata to a replacement or resurrect it after truncation", () => {
      createSession("sess-metadata-replace", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-metadata-replace", [
        { role: "user", content: textContent("question"), timestamp: 1000, logicalId: "question-id" },
        { role: "assistant", content: textContent("old answer"), timestamp: 2000, logicalId: "old-answer-id" },
        { role: "user", content: textContent("remove me"), timestamp: 3000, logicalId: "removed-id" },
      ]);
      const originalPage = loadMessagePage("sess-metadata-replace", 10);
      attachStoredMessageMetadata("sess-metadata-replace", originalPage.items[1].id, "marker", { value: "answer" });
      attachStoredMessageMetadata("sess-metadata-replace", originalPage.items[2].id, "marker", { value: "removed" });

      const replacement = [
        { role: "user", content: textContent("question"), timestamp: 1000, logicalId: "question-id" },
        { role: "assistant", content: textContent("replacement"), timestamp: 4000, logicalId: "replacement-id" },
      ];
      persistMessages("sess-metadata-replace", replacement);

      expect(loadMessages("sess-metadata-replace")).toEqual(replacement);

      persistMessages("sess-metadata-replace", [
        ...replacement,
        { role: "user", content: textContent("new use of old timestamp"), timestamp: 3000, logicalId: "new-id" },
      ]);
      const appendedId = loadMessagePage("sess-metadata-replace", 10).items[2].id;
      expect(appendedId).not.toBe(originalPage.items[2].id);
      expect(loadMessagePage("sess-metadata-replace", 10).items[2].message).not.toHaveProperty("metadata");
    });

    test("copies metadata only for retained messages at a new compaction boundary", () => {
      createSession("sess-metadata-compact", projectId, { agentRuntimeType: "pi" });
      const retained = { role: "assistant", content: textContent("retained answer"), timestamp: 2000, logicalId: "retained-id" };
      persistMessages("sess-metadata-compact", [
        { role: "user", content: textContent("archived question"), timestamp: 1000, logicalId: "archived-id" },
        retained,
        { role: "user", content: textContent("omitted tail"), timestamp: 3000, logicalId: "omitted-id" },
      ]);
      const beforeCompaction = loadMessagePage("sess-metadata-compact", 10);
      attachStoredMessageMetadata("sess-metadata-compact", beforeCompaction.items[0].id, "marker", { value: "archived" });
      attachStoredMessageMetadata("sess-metadata-compact", beforeCompaction.items[1].id, "marker", { value: "retained" });
      attachStoredMessageMetadata("sess-metadata-compact", beforeCompaction.items[2].id, "marker", { value: "omitted" });

      persistMessages("sess-metadata-compact", [
        { role: "compactionSummary", summary: "summary", timestamp: 4000, logicalId: "summary-id" },
        retained,
      ]);

      const fullPage = loadMessagePage("sess-metadata-compact", 10);
      expect(fullPage.items.at(-1)!.message.metadata).toEqual({ marker: { value: "retained" } });
      expect(fullPage.items[0].message.metadata).toEqual({ marker: { value: "archived" } });
      expect(fullPage.items[2].message.metadata).toEqual({ marker: { value: "omitted" } });
      expect(loadMessagesForLLM("sess-metadata-compact")).toEqual([
        { role: "compactionSummary", summary: "summary", timestamp: 4000, logicalId: "summary-id" },
        retained,
      ]);
    });
  });

  describe("metadata identity", () => {
    test("distinguishes tool results sharing a timestamp by tool call ID", () => {
      createSession("sess-tool-metadata", projectId, { agentRuntimeType: "pi" });
      const result: RuntimeMessage = {
        role: "toolResult", toolCallId: "call-a", toolName: "read", logicalId: "result-id",
        content: textContent("old result"), isError: false, timestamp: 1000,
      };
      persistMessages("sess-tool-metadata", [result]);
      const id = loadMessagePage("sess-tool-metadata", 10).items[0].id;
      attachStoredMessageMetadata("sess-tool-metadata", id, "audit", true);
      persistMessages("sess-tool-metadata", [{ ...result, content: textContent("updated result") }]);
      expect(loadMessagePage("sess-tool-metadata", 10).items[0].message.metadata).toEqual({ audit: true });

      persistMessages("sess-tool-metadata", [{ ...result, toolCallId: "call-b", logicalId: "replacement-id" }]);
      expect(loadMessagePage("sess-tool-metadata", 10).items[0].message).not.toHaveProperty("metadata");
    });

    test("uses logical IDs despite duplicate timestamps across compaction", () => {
      createSession("sess-ambiguous", projectId, { agentRuntimeType: "pi" });
      const first = { role: "assistant", content: textContent("first"), timestamp: 1000, logicalId: "first-id" };
      const second = { role: "assistant", content: textContent("second"), timestamp: 1000, logicalId: "second-id" };
      const unique = { role: "user", content: textContent("unique before compaction"), timestamp: 2000, logicalId: "unique-id" };
      persistMessages("sess-ambiguous", [first, second, unique]);
      const page = loadMessagePage("sess-ambiguous", 10);
      attachStoredMessageMetadata("sess-ambiguous", page.items[0].id, "audit", "first");
      attachStoredMessageMetadata("sess-ambiguous", page.items[2].id, "audit", "unique");

      persistMessages("sess-ambiguous", [
        { role: "compactionSummary", summary: "summary", timestamp: 3000 },
        first, unique, { ...unique, logicalId: "duplicate-id", content: textContent("duplicate after compaction") },
      ]);

      const stored = loadMessages("sess-ambiguous");
      expect(stored.slice(3).map((message) => message.metadata)).toEqual([
        undefined, { audit: "first" }, { audit: "unique" }, undefined,
      ]);
      expect(stored[0].metadata).toEqual({ audit: "first" });
      expect(stored[2].metadata).toEqual({ audit: "unique" });
    });
  });

  describe("loadMessages", () => {
    test("returns empty array for session with no messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      expect(loadMessages("sess-1")).toEqual([]);
    });

    test("returns messages ordered by seq with block-only content", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("first") },
        { role: "assistant", content: textContent("second") },
        { role: "user", content: textContent("third") },
      ]);

      const msgs = loadMessages("sess-1");
      expect(msgs).toHaveLength(3);
      expect(msgs[0].content).toEqual(textContent("first"));
      expect(msgs[1].content).toEqual(textContent("second"));
      expect(msgs[2].content).toEqual(textContent("third"));
    });
  });

  describe("listSessionEntries", () => {
    test("filters persisted message entries and returns latest limited entries chronologically", () => {
      createSession("sess-query", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-query", [
        { role: "user", content: textContent("first prompt") },
        { role: "assistant", content: [{ type: "text", text: "second response" }] },
        { role: "user", content: [{ type: "thinking", thinking: "third thought" }] },
      ]);

      const latest = listSessionEntries("sess-query", { types: ["user", "assistant"], limit: 2 });

      expect(latest.map((m) => ({ seq: m.seq, type: m.type }))).toEqual([
        { seq: 1, type: "assistant" },
        { seq: 2, type: "user" },
      ]);
      expect(latest[0]).toMatchObject({ content: [{ type: "text", text: "second response" }] });
      expect(latest[1]).toMatchObject({ content: [{ type: "thinking", thinking: "third thought" }] });

      const searched = listSessionEntries("sess-query", { types: ["user"], search: "third" });
      expect(searched.map((m) => m.seq)).toEqual([2]);
    });

    test("extracts compact tool call entries with joined results", () => {
      createSession("sess-trace", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-trace", [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-read", name: "read", arguments: { path: "src/a.ts" } }],
        },
        {
          role: "toolResult",
          toolCallId: "tc-read",
          toolName: "read",
          isError: false,
          content: textContent("file contents"),
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll run a command" },
            { type: "toolCall", id: "tc-bash", name: "bash", arguments: { command: "exit 1" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc-bash",
          isError: true,
          content: textContent("long failure output"),
        },
      ]);

      const bashCall = {
        sessionId: "sess-trace",
        seq: 2,
        created_at: expect.any(String),
        type: "toolCall" as const,
        id: "tc-bash",
        name: "bash",
        arguments: { command: "exit 1" },
        result: {
          seq: 3,
          created_at: expect.any(String),
          isError: true,
          contentPreview: "long failure output",
          content: textContent("long failure output"),
        },
      };

      expect(listSessionEntries("sess-trace", { types: ["toolCall"], toolName: "bash", includeContent: true })).toEqual([bashCall]);
      expect(listSessionEntries("sess-trace", { types: ["toolCall"], search: "long failure", includeContent: true })).toEqual([bashCall]);
      expect(listSessionEntries("sess-trace", { isError: true }).map((item) => item.seq)).toEqual([2]);
    });

    test("can return a combined session timeline with derived tool calls", () => {
      createSession("sess-entries", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-entries", [
        { role: "user", content: textContent("read the file") },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll inspect it" },
            { type: "toolCall", id: "tc-read", name: "read", arguments: { path: "README.md" } },
          ],
        },
        { role: "toolResult", toolCallId: "tc-read", toolName: "read", isError: false, content: textContent("contents") },
      ]);

      const entries = listSessionEntries("sess-entries");

      expect(entries.map((entry) => ({ seq: entry.seq, type: entry.type }))).toEqual([
        { seq: 0, type: "user" },
        { seq: 1, type: "assistant" },
        { seq: 1, type: "toolCall" },
      ]);
    });

    test("uses latest-window defaults but honors explicit ascending order for entry limits", () => {
      createSession("sess-trace-order", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-trace-order", [
        { role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "one" } }] },
        { role: "assistant", content: [{ type: "toolCall", id: "tc-2", name: "read", arguments: { path: "two" } }] },
        { role: "assistant", content: [{ type: "toolCall", id: "tc-3", name: "read", arguments: { path: "three" } }] },
      ]);

      expect(listSessionEntries("sess-trace-order", { types: ["toolCall"], limit: 2 }).map((item) => item.seq)).toEqual([1, 2]);
      expect(listSessionEntries("sess-trace-order", { types: ["toolCall"], order: "asc", limit: 2 }).map((item) => item.seq)).toEqual([0, 1]);
      expect(listSessionEntries("sess-trace-order", { types: ["toolCall"], order: "desc", limit: 2 }).map((item) => item.seq)).toEqual([2, 1]);
    });
  });

  describe("loadMessagesForLLM", () => {
    test("returns all messages when no compaction has occurred", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("hello") },
        { role: "assistant", content: textContent("hi") },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      expect(msgs).toHaveLength(2);
    });

    test("returns compactionSummary and post-compaction messages while excluding pre-compaction history", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("old message") },
        { role: "assistant", content: textContent("old reply") },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary of old" },
        { role: "user", content: textContent("new message") },
        { role: "assistant", content: textContent("new reply") },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      expect(msgs).toHaveLength(3);
      expect(msgs[0].role).toBe("compactionSummary");
      expect(msgs[0].summary).toBe("summary of old");
      expect(msgs[1].content).toEqual(textContent("new message"));
      expect(msgs[2].content).toEqual(textContent("new reply"));

      const contents = msgs.map(messageText);
      expect(contents).not.toContain("old message");
      expect(contents).not.toContain("old reply");
    });
  });

  describe("compaction", () => {
    test("persists a compaction boundary with summary text and prunes pre-boundary tool results", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("old") },
        { role: "toolResult", content: [{ type: "text", text: "big result data" }] },
        { role: "assistant", content: textContent("old reply") },
      ]);

      const summary = "## Goal\nBuild a widget\n\n## Progress\n- [x] Created skeleton";
      persistMessages("sess-1", [
        { role: "compactionSummary", summary },
        { role: "user", content: textContent("new question") },
      ]);

      const all = loadMessages("sess-1");
      // old messages(3) + compactionSummary(1) + new question(1)
      expect(all).toHaveLength(5);
      expect(all[3].role).toBe("compactionSummary");
      expect(all[3].summary).toBe(summary);
      expect(all[4].content).toEqual(textContent("new question"));
      expect(all.map(messageText)).toContain("old");
      expect(all.map(messageText)).toContain("old reply");

      const toolResult = all.find((m: any) => m.role === "toolResult");
      expect(toolResult).toBeDefined();
      expect(toolResult.content).toEqual([{ type: "text", text: "[pruned]" }]);
    });

    test("new messages persist correctly after compaction", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("msg 1") },
        { role: "assistant", content: textContent("reply 1") },
        { role: "user", content: textContent("msg 2") },
        { role: "assistant", content: textContent("reply 2") },
      ]);

      // Compaction replaces pi's in-memory array
      const postCompaction = [
        { role: "compactionSummary", summary: "compacted context" },
        { role: "user", content: textContent("kept question") },
        { role: "assistant", content: textContent("kept reply") },
      ];
      persistMessages("sess-1", postCompaction);

      // User continues — pi's array grows
      persistMessages("sess-1", [
        ...postCompaction,
        { role: "user", content: textContent("new question") },
        { role: "assistant", content: textContent("new answer") },
      ]);

      const llmMsgs = loadMessagesForLLM("sess-1");
      expect(llmMsgs.map(messageText)).toContain("new question");
      expect(llmMsgs.map(messageText)).toContain("new answer");

      const allMsgs = loadMessages("sess-1");
      const allContents = allMsgs.map(messageText);
      expect(allContents).toContain("new question");
      expect(allContents).toContain("new answer");
    });

    test("reconciles a failed retry inside the active compacted tail without rewriting archived history", () => {
      createSession("sess-compact-retry", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-compact-retry", [
        { role: "assistant", content: [{ type: "toolCall", id: "archived-call", name: "read", arguments: {} }] },
        { role: "toolResult", toolCallId: "archived-call", isError: false, content: textContent("old output") },
      ]);
      const archivedPage = loadMessagePage("sess-compact-retry", 10);
      const summary = { role: "compactionSummary", summary: "archived work" };
      persistMessages("sess-compact-retry", [summary, ...failedRetrySnapshot]);
      const failedActivePage = loadMessagePage("sess-compact-retry", 10);

      persistMessages("sess-compact-retry", [summary, ...successfulRetrySnapshot]);

      const all = loadMessages("sess-compact-retry");
      const active = loadMessagesForLLM("sess-compact-retry");
      const reconciledPage = loadMessagePage("sess-compact-retry", 10);
      expect(all).toHaveLength(6);
      expect(all[1].content).toEqual(textContent("[pruned]"));
      expect(reconciledPage.items[0].id).toBe(archivedPage.items[0].id);
      expect(reconciledPage.items[1].id).toBe(archivedPage.items[1].id);
      expect(reconciledPage.items[4].id).toBe(failedActivePage.items[4].id);
      expect(toolCallIdsMatch(active)).toBe(true);
    });

    test("re-compaction appends new summary when retained tail length matches previous tail", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });

      persistMessages("sess-1", [
        { role: "user", content: textContent("before compaction") },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary v1" },
        { role: "assistant", content: textContent("retained tail v1") },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary v2" },
        { role: "assistant", content: textContent("retained tail v2") },
      ]);

      const allMsgs = loadMessages("sess-1");
      const allContents = allMsgs.map(messageText);
      expect(allContents).toContain("summary v1");
      expect(allContents).toContain("retained tail v1");
      expect(allContents).toContain("summary v2");
      expect(allContents).toContain("retained tail v2");

      const llmMsgs = loadMessagesForLLM("sess-1");
      expect(llmMsgs).toHaveLength(2);
      expect(llmMsgs[0].role).toBe("compactionSummary");
      expect(llmMsgs[0].summary).toBe("summary v2");
      expect(llmMsgs[1].content).toEqual(textContent("retained tail v2"));
    });

    test("re-compaction prunes tool results from all pre-compaction messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });

      // Messages with tool results
      persistMessages("sess-1", [
        { role: "user", content: textContent("question") },
        { role: "toolResult", toolCallId: "tc0", content: [{ type: "text", text: "early tool output" }] },
        { role: "assistant", content: textContent("answer") },
      ]);

      // First compaction
      const postCompact1: RuntimeMessage[] = [
        { role: "compactionSummary", summary: "summary v1" },
        { role: "toolResult", toolCallId: "tc1", content: textContent("kept tool output") },
        { role: "assistant", content: textContent("reply") },
      ];
      persistMessages("sess-1", postCompact1);

      // Re-compaction
      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary v2" },
        { role: "assistant", content: textContent("final") },
      ]);

      const allMsgs = loadMessages("sess-1");

      // All toolResult messages before the latest compaction should be pruned
      const toolResults = allMsgs.filter((m: any) => m.role === "toolResult");
      for (const tr of toolResults) {
        expect(tr.content).toEqual([{ type: "text", text: "[pruned]" }]);
      }

      // No orphaned tool results in LLM context
      const llmMsgs = loadMessagesForLLM("sess-1");
      const llmToolResults = llmMsgs.filter((m: any) => m.role === "toolResult");
      expect(llmToolResults).toHaveLength(0);
    });
  });
});
