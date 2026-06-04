import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import {
  loadMessages,
  loadMessagesForLLM,
  listSessionEntries,
  persistMessages,
} from "../messages-store.js";

let projectId: number;

function textContent(text: string) {
  return [{ type: "text" as const, text }];
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
      const msgs = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ];
      persistMessages("sess-1", msgs);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(2);
      expect(loaded[0].role).toBe("user");
      expect(loaded[1].role).toBe("assistant");
    });

    test("is idempotent — re-calling with same messages inserts nothing new", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const msgs = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      persistMessages("sess-1", msgs);
      persistMessages("sess-1", msgs);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(1);
    });

    test("appends only new messages on subsequent calls", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const batch1 = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      persistMessages("sess-1", batch1);

      const batch2 = [
        ...batch1,
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ];
      persistMessages("sess-1", batch2);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(2);
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

    test("includes compaction markers", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("before compaction") },
        { role: "assistant", content: textContent("reply") },
      ]);

      // Pi compacts and replaces in-memory array
      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "discussed things" },
        { role: "user", content: textContent("after compaction") },
      ]);

      const msgs = loadMessages("sess-1");
      const roles = msgs.map((m: any) => m.role);
      expect(roles).toContain("compactionSummary");
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

    test("returns compactionSummary and post-compaction messages", () => {
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
    });

    test("excludes pre-compaction messages from LLM context", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("old") },
        { role: "assistant", content: textContent("old reply") },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary" },
        { role: "user", content: textContent("new") },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      const contents = msgs.map(messageText);
      expect(contents).not.toContain("old");
      expect(contents).not.toContain("old reply");
    });
  });

  describe("compaction", () => {
    test("persistMessages detects compactionSummary and creates boundary", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("old") },
        { role: "assistant", content: textContent("old reply") },
      ]);

      // Pi compacts — in-memory array now starts with compactionSummary
      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "discussed old topics" },
        { role: "user", content: textContent("new question") },
      ]);

      const all = loadMessages("sess-1");
      // old(2) + compactionSummary(1) + new(1) = 4
      expect(all).toHaveLength(4);
      expect(all[2].role).toBe("compactionSummary");
      expect(all[3].content).toEqual(textContent("new question"));
    });

    test("preserves summary text from compactionSummary message", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("old") },
        { role: "assistant", content: textContent("old reply") },
      ]);

      const summary = "## Goal\nBuild a widget\n\n## Progress\n- [x] Created skeleton";
      persistMessages("sess-1", [
        { role: "compactionSummary", summary },
        { role: "user", content: textContent("new") },
      ]);

      const all = loadMessages("sess-1");
      const marker = all.find((m: any) => m.role === "compactionSummary");
      expect(marker).toBeDefined();
      expect(marker.summary).toBe(summary);
    });

    test("prunes tool result content from pre-compaction messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("question") },
        { role: "toolResult", content: [{ type: "text", text: "big result data" }] },
        { role: "assistant", content: textContent("answer") },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary" },
        { role: "user", content: textContent("post-compact msg") },
      ]);

      const all = loadMessages("sess-1");
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

    test("handles multiple compactions", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: textContent("batch 1") },
        { role: "assistant", content: textContent("reply 1") },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary of batch 1" },
        { role: "user", content: textContent("batch 2") },
        { role: "assistant", content: textContent("reply 2") },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary of batches 1-2" },
        { role: "user", content: textContent("batch 3") },
      ]);

      // loadMessagesForLLM returns last compactionSummary + post-compaction messages
      const llmMsgs = loadMessagesForLLM("sess-1");
      expect(llmMsgs).toHaveLength(2);
      expect(llmMsgs[0].role).toBe("compactionSummary");
      expect(llmMsgs[0].summary).toBe("summary of batches 1-2");
      expect(llmMsgs[1].content).toEqual(textContent("batch 3"));

      // Full history: pre-compaction + first CS + second CS + new post-compaction
      // Old post-compaction messages (batch 2, reply 2) are deleted during re-compaction
      // since they're now subsumed by the new compaction summary.
      const allMsgs = loadMessages("sess-1");
      const allRoles = allMsgs.map((m: any) => m.role);
      expect(allRoles.filter((r: string) => r === "compactionSummary")).toHaveLength(2);
      const allContents = allMsgs.map(messageText);
      expect(allContents).toContain("batch 1");
      expect(allContents).toContain("summary of batch 1");
      expect(allContents).toContain("summary of batches 1-2");
      expect(allContents).toContain("batch 3");
      // Old post-compaction messages are removed — they're subsumed by the new CS
      expect(allContents).not.toContain("batch 2");
      expect(allContents).not.toContain("reply 2");
    });

    test("re-compaction does not duplicate messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });

      // Initial messages
      persistMessages("sess-1", [
        { role: "user", content: textContent("msg 1") },
        { role: "assistant", content: textContent("reply 1") },
        { role: "user", content: textContent("msg 2") },
        { role: "assistant", content: textContent("reply 2") },
      ]);

      // First compaction — pi's array is now [CS1, msg 2, reply 2]
      const postCompact1 = [
        { role: "compactionSummary", summary: "summary v1" },
        { role: "user", content: textContent("msg 2") },
        { role: "assistant", content: textContent("reply 2") },
      ];
      persistMessages("sess-1", postCompact1);

      // User continues — pi's array grows
      const continued = [
        ...postCompact1,
        { role: "user", content: textContent("msg 3") },
        { role: "assistant", content: textContent("reply 3") },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "tool output" }] },
        { role: "assistant", content: textContent("reply 4") },
      ];
      persistMessages("sess-1", continued);

      // Re-compaction — pi compacts again, new summary subsumes everything
      const postCompact2 = [
        { role: "compactionSummary", summary: "summary v2" },
        { role: "assistant", content: textContent("reply 4") },
      ];
      persistMessages("sess-1", postCompact2);

      // Verify no duplicates: each content value appears at most once
      const allMsgs = loadMessages("sess-1");
      const allContents = allMsgs.map(messageText);
      const duplicates = allContents.filter((c, i) => allContents.indexOf(c) !== i);
      expect(duplicates).toEqual([]);

      // LLM context uses only the latest compaction
      const llmMsgs = loadMessagesForLLM("sess-1");
      expect(llmMsgs).toHaveLength(2);
      expect(llmMsgs[0].role).toBe("compactionSummary");
      expect(llmMsgs[0].summary).toBe("summary v2");
      expect(llmMsgs[1].content).toEqual(textContent("reply 4"));

      // Old post-compaction messages were deleted, not duplicated
      const msgContents = allMsgs.map(messageText);
      expect(msgContents.filter((c) => c === "reply 4")).toHaveLength(1);
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
      const postCompact1 = [
        { role: "compactionSummary", summary: "summary v1" },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "kept tool output" }] },
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
