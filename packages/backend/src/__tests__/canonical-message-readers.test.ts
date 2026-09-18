import { describe, expect, test } from "bun:test";
import { getDb } from "../db.js";
import { listSessionEntries, loadActiveMessages, loadMessagePage, loadMessages } from "../messages-store.js";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import { useTestDb } from "./helpers/test-db.js";

function insertEntry(sessionId: string, seq: number, harnessId: string, entry: Record<string, unknown>, parentId: number | null) {
  const message = entry.message;
  const role = entry.type === "message" && message && typeof message === "object" && "role" in message
    ? String(message.role)
    : String(entry.type);
  return getDb().query<{ id: number }, [string, number, number | null, string, string, string]>(
    `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z') RETURNING id`,
  ).get(sessionId, seq, parentId, harnessId, role, JSON.stringify(entry))!.id;
}

const text = (value: string) => [{ type: "text", text: value }];

describe("canonical AgentHarness message readers", () => {
  useTestDb();

  test("projects archive rows without changing row identity or attachment references", () => {
    const project = createProject("Canonical", "/tmp/canonical-readers");
    createSession("canonical", project.id, { agentRuntimeType: "pi" });
    const user = insertEntry("canonical", 2, "entry-user", {
      type: "message", timestamp: 10,
      message: { role: "reinsInput", content: [{ type: "image", attachmentId: "att_1", mimeType: "image/png", byteSize: 4 }], reinsId: "input-1", metadata: {}, timestamp: 10 },
    }, null);
    const assistant = insertEntry("canonical", 5, "entry-assistant", {
      type: "message", timestamp: 20,
      message: { role: "assistant", content: text("done"), stopReason: "stop", timestamp: 20 },
    }, user);
    insertEntry("canonical", 8, "entry-custom", { type: "custom", customType: "internal", timestamp: 30 }, assistant);

    expect(loadMessages("canonical")).toEqual([
      { role: "user", content: [{ type: "image", attachmentId: "att_1", mimeType: "image/png", byteSize: 4 }], timestamp: 10 },
      { role: "assistant", content: text("done"), stopReason: "stop", timestamp: 20 },
    ]);
    const page = loadMessagePage("canonical", 10);
    expect(page.items.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: String(user), parentId: null },
      { id: String(assistant), parentId: String(user) },
    ]);
  });

  test("searches projected content and keeps tool calls with canonical result rows", () => {
    const project = createProject("Tools", "/tmp/canonical-tools");
    createSession("tools", project.id, { agentRuntimeType: "pi" });
    const call = insertEntry("tools", 1, "call-entry", {
      type: "message", timestamp: 10,
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }], stopReason: "toolUse", timestamp: 10 },
    }, null);
    insertEntry("tools", 4, "result-entry", {
      type: "message", timestamp: 20,
      message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: text("unique result"), isError: false, timestamp: 20 },
    }, call);

    const entries = listSessionEntries("tools", { types: ["toolCall"], search: "unique result", includeContent: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "call-1", name: "read", result: { contentPreview: "unique result" } });

    const first = loadMessagePage("tools", 1, { afterSeq: 0 });
    expect(first.items).toHaveLength(2);
    expect(first.items.at(-1)?.message.role).toBe("toolResult");
  });

  test("loads results from main ancestry rather than newer archived rows", () => {
    const project = createProject("Branches", "/tmp/canonical-branches");
    createSession("branches", project.id, { agentRuntimeType: "pi" });
    const root = insertEntry("branches", 0, "root", { type: "message", timestamp: 1, message: { role: "user", content: text("question"), timestamp: 1 } }, null);
    insertEntry("branches", 1, "active", { type: "message", timestamp: 2, message: { role: "assistant", content: text("active"), stopReason: "stop", timestamp: 2 } }, root);
    insertEntry("branches", 2, "archived", { type: "message", timestamp: 3, message: { role: "assistant", content: text("archived"), stopReason: "stop", timestamp: 3 } }, root);
    getDb().query(`INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES ('branches', 'pi.branch.tip', 'main', 3, '"active"')`).run();

    expect(loadMessages("branches").map((message) => message.content?.[0]?.text)).toEqual(["question", "active", "archived"]);
    expect(loadActiveMessages("branches").map((message) => message.content?.[0]?.text)).toEqual(["question", "active"]);
  });

  test("projects compaction once while retaining archived ancestors for display", () => {
    const project = createProject("Compaction", "/tmp/canonical-compaction");
    createSession("compact", project.id, { agentRuntimeType: "pi" });
    const archived = insertEntry("compact", 0, "old", { type: "message", timestamp: 1, message: { role: "user", content: text("old"), timestamp: 1 } }, null);
    const summary = insertEntry("compact", 2, "summary", { type: "compaction", timestamp: 2, summary: "summary", retainedTail: [], tokensBefore: 0, fromHook: false }, archived);
    insertEntry("compact", 3, "tail", { type: "message", timestamp: 3, message: { role: "assistant", content: text("tail"), stopReason: "stop", timestamp: 3 } }, summary);

    expect(loadMessages("compact").map((message) => message.role)).toEqual(["user", "compactionSummary", "assistant"]);
    expect(loadMessages("compact").filter((message) => message.role === "compactionSummary")).toHaveLength(1);
  });
});
