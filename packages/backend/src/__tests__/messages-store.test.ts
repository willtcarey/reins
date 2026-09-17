import { describe, expect, test } from "bun:test";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import { listSessionEntries, loadMessagePage, loadMessages, parseDisplayCursor } from "../messages-store.js";
import { useTestDb } from "./helpers/test-db.js";
import { persistCanonicalMessages } from "./helpers/canonical-messages.js";

describe("canonical messages store", () => {
  useTestDb();

  test("reads canonical entries for archive and timeline projections", () => {
    const project = createProject("Messages", "/tmp/messages");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("session", [
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } }] },
      { role: "toolResult", toolCallId: "call", toolName: "read", isError: false, content: [{ type: "text", text: "answer" }] },
    ]);

    expect(loadMessages("session").map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(listSessionEntries("session", { types: ["toolCall"], search: "answer" })).toHaveLength(1);
    expect(loadMessagePage("session", 10).items).toHaveLength(3);
  });

  test("keeps tool calls paired with results across entry windows and result-only search", () => {
    const project = createProject("Messages", "/tmp/messages");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("session", [
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "assistant-only-token" } }] },
      { role: "toolResult", toolCallId: "call", toolName: "read", isError: false, content: [{ type: "text", text: "needle only in result" }] },
    ]);

    const entries = listSessionEntries("session", {
      types: ["toolCall"],
      afterSeq: 0,
      search: "needle only in result",
      includeContent: true,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "toolCall", id: "call", result: { seq: 1 } });

    expect(listSessionEntries("session", {
      types: ["toolCall"], beforeSeq: 1, search: "needle only in result",
    })).toEqual([]);
    expect(listSessionEntries("session", {
      types: ["toolCall"], afterSeq: 0, search: "assistant-only-token",
    })).toEqual([]);
  });

  test("reports opposite-boundary navigation for empty bounded pages", () => {
    const project = createProject("Messages", "/tmp/messages");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("session", [{ role: "user", content: [{ type: "text", text: "only" }] }]);

    expect(loadMessagePage("session", 5, { afterSeq: 100 }).pageInfo).toMatchObject({
      hasPreviousPage: true,
      hasNextPage: false,
    });
    expect(loadMessagePage("session", 5, { beforeSeq: 0 }).pageInfo).toMatchObject({
      hasNextPage: true,
    });
  });

  test("preserves compaction archive display and attachment references", () => {
    const project = createProject("Messages", "/tmp/messages");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("session", [
      { role: "user", content: [{ type: "image", data: "attachment:asset-1", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "text", text: "before compaction" }] },
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: [{ type: "text", text: "after" }] },
    ]);

    const page = loadMessagePage("session", 10);
    expect(page.items.map((item) => item.message.role)).toEqual([
      "user", "assistant", "compactionSummary", "user",
    ]);
    expect(page.items[0]?.message).toMatchObject({
      content: [{ type: "image", data: "attachment:asset-1", mimeType: "image/png" }],
    });
  });

  test("uses opaque session-scoped directional cursors", () => {
    expect(parseDisplayCursor("session", Buffer.from(JSON.stringify({ sessionId: "session", seq: 4, direction: "after" })).toString("base64url"), "after")).toBe(4);
    expect(parseDisplayCursor("other", Buffer.from(JSON.stringify({ sessionId: "session", seq: 4, direction: "after" })).toString("base64url"), "after")).toBeNull();
  });
});
