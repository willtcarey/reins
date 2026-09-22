import { describe, expect, test } from "bun:test";
import {
  calculateContextTokens,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  estimateTokens,
} from "@earendil-works/pi-agent-core";
import { getDb } from "../../db.js";
import { buildSessionContextSnapshot } from "../../models/session-context.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { useTestDb } from "../helpers/test-db.js";

const usage = (totalTokens: number, input = 1) => ({
  input,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("buildSessionContextSnapshot", () => {
  useTestDb();

  test("reports an empty new session as zero context usage", async () => {
    const project = createProject("New session", "/tmp/new-session");
    createSession("new-session", project.id, { agentRuntimeType: "pi" });

    expect(await buildSessionContextSnapshot("new-session", { contextWindow: 200, reserveTokens: 20 })).toEqual({
      usedTokens: 0,
      contextWindow: 200,
      compactionThresholdTokens: 180,
      utilization: 0,
      measurement: "exact",
    });
  });

  test("uses the latest active assistant-linked usage instead of cumulative or structural usage", async () => {
    const project = createProject("Context", "/tmp/context");
    createSession("context-session", project.id, { agentRuntimeType: "pi" });
    const db = getDb();
    const insertEntry = db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    insertEntry.run("context-session", 1, null, "assistant-1", "assistant", JSON.stringify({
      type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }], usage: usage(40), stopReason: "stop", timestamp: 1 },
    }));
    const firstRow = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    insertEntry.run("context-session", 3, firstRow, "assistant-2", "assistant", JSON.stringify({
      type: "message", message: { role: "assistant", content: [{ type: "text", text: "second" }], usage: usage(120), stopReason: "stop", timestamp: 2 },
    }));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("context-session", "usage-1", 2, "assistant-1", JSON.stringify(usage(40)));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("context-session", "usage-2", 4, "assistant-2", JSON.stringify(usage(120)));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("context-session", "compaction-request", 5, null, JSON.stringify(usage(900)));
    insertEntry.run("context-session", 6, null, "archived-assistant", "assistant", JSON.stringify({
      type: "message", message: {
        role: "assistant", content: [{ type: "text", text: "archived" }],
        usage: usage(190), stopReason: "stop", timestamp: 3,
      },
    }));
    db.query("INSERT INTO pi_values (session_id,namespace,key,seq,value_json) VALUES (?,?,?,?,?)")
      .run("context-session", "pi.branch.tip", "main", 7, JSON.stringify("assistant-2"));

    expect(await buildSessionContextSnapshot("context-session", { contextWindow: 200, reserveTokens: 20 })).toEqual({
      usedTokens: calculateContextTokens(usage(120)),
      contextWindow: 200,
      compactionThresholdTokens: 180,
      utilization: 0.6,
      measurement: "exact",
    });
  });

  test("uses AgentHarness fallback token calculation when totalTokens is zero", async () => {
    const project = createProject("Fallback", "/tmp/fallback");
    createSession("fallback-session", project.id, { agentRuntimeType: "pi" });
    const db = getDb();
    db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, 1, NULL, 'assistant', 'assistant', ?, datetime('now'))`,
    ).run("fallback-session", JSON.stringify({
      type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: usage(0, 11), stopReason: "stop", timestamp: 1 },
    }));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("fallback-session", "usage", 2, "assistant", JSON.stringify(usage(0, 11)));
    db.query("INSERT INTO pi_values (session_id,namespace,key,seq,value_json) VALUES (?,?,?,?,?)")
      .run("fallback-session", "pi.branch.tip", "main", 3, JSON.stringify("assistant"));

    expect((await buildSessionContextSnapshot("fallback-session", { contextWindow: 200, reserveTokens: 20 })).usedTokens)
      .toBe(20);
  });

  test("estimates context instead of accepting an all-zero assistant measurement", async () => {
    const project = createProject("Zero", "/tmp/zero");
    createSession("zero-session", project.id, { agentRuntimeType: "pi" });
    const db = getDb();
    db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, 1, NULL, 'assistant', 'assistant', ?, datetime('now'))`,
    ).run("zero-session", JSON.stringify({
      type: "message", message: {
        role: "assistant", content: [{ type: "text", text: "answer" }],
        usage: { ...usage(0, 0), output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 1,
      },
    }));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("zero-session", "usage", 2, "assistant", JSON.stringify({
        ...usage(0, 0), output: 0, cacheRead: 0, cacheWrite: 0,
      }));
    db.query("INSERT INTO pi_values (session_id,namespace,key,seq,value_json) VALUES (?,?,?,?,?)")
      .run("zero-session", "pi.branch.tip", "main", 3, JSON.stringify("assistant"));

    expect(await buildSessionContextSnapshot("zero-session", { contextWindow: 200, reserveTokens: 20 }))
      .toMatchObject({ usedTokens: 2, measurement: "estimated" });
  });

  test("estimates trailing Reins inputs and branch summaries after the latest assistant usage", async () => {
    const project = createProject("Trailing", "/tmp/trailing");
    createSession("trailing-session", project.id, { agentRuntimeType: "pi" });
    const db = getDb();
    const insert = db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    insert.run("trailing-session", 1, null, "assistant", "assistant", JSON.stringify({
      type: "message", timestamp: 1,
      message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: usage(100), stopReason: "stop", timestamp: 1 },
    }));
    const assistantRow = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    const input = { role: "reinsInput", content: [{ type: "text" as const, text: "follow up question" }], reinsId: "input", metadata: {}, timestamp: 2 };
    insert.run("trailing-session", 3, assistantRow, "input", "reinsInput", JSON.stringify({ type: "message", timestamp: 2, message: input }));
    const inputRow = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    insert.run("trailing-session", 4, inputRow, "summary", "branch_summary", JSON.stringify({
      type: "branch_summary", summary: "Branch context", fromId: "assistant", timestamp: 3,
    }));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("trailing-session", "usage", 2, "assistant", JSON.stringify(usage(100)));
    db.query("INSERT INTO pi_values (session_id,namespace,key,seq,value_json) VALUES (?,?,?,?,?)")
      .run("trailing-session", "pi.branch.tip", "main", 5, JSON.stringify("summary"));

    const expected = 100
      + estimateTokens({ role: "user", content: input.content, timestamp: input.timestamp })
      + estimateTokens(createBranchSummaryMessage("Branch context", "assistant", 3));
    expect(await buildSessionContextSnapshot("trailing-session", { contextWindow: 500, reserveTokens: 20 })).toEqual({
      usedTokens: expected,
      contextWindow: 500,
      compactionThresholdTokens: 480,
      utilization: expected / 500,
      measurement: "estimated",
    });
  });

  test("marks provider usage estimated when a tool result trails the measured assistant", async () => {
    const project = createProject("Tool result", "/tmp/tool-result");
    createSession("tool-result-session", project.id, { agentRuntimeType: "pi" });
    const db = getDb();
    const insert = db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    insert.run("tool-result-session", 1, null, "assistant", "assistant", JSON.stringify({
      type: "message", timestamp: 1,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        usage: usage(100), stopReason: "toolUse", timestamp: 1,
      },
    }));
    const assistantRow = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    const result = {
      role: "toolResult" as const, toolCallId: "call", toolName: "read",
      content: [{ type: "text" as const, text: "x".repeat(400) }], isError: false, timestamp: 2,
    };
    insert.run("tool-result-session", 2, assistantRow, "result", "toolResult", JSON.stringify({
      type: "message", timestamp: 2, message: result,
    }));
    db.query("INSERT INTO pi_values (session_id,namespace,key,seq,value_json) VALUES (?,?,?,?,?)")
      .run("tool-result-session", "pi.branch.tip", "main", 3, JSON.stringify("result"));

    const expected = 100 + estimateTokens(result);
    expect(await buildSessionContextSnapshot("tool-result-session", { contextWindow: 500, reserveTokens: 20 }))
      .toMatchObject({ usedTokens: expected, measurement: "estimated" });
  });

  test("ignores failed assistant usage in restored occupancy", async () => {
    const project = createProject("Failed", "/tmp/failed");
    createSession("failed-session", project.id, { agentRuntimeType: "pi" });
    const db = getDb();
    const insert = db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, ?, ?, ?, 'assistant', ?, datetime('now'))`,
    );
    insert.run("failed-session", 1, null, "good", JSON.stringify({
      type: "message", message: { role: "assistant", content: [{ type: "text", text: "good" }], usage: usage(40), stopReason: "stop", timestamp: 1 },
    }));
    const goodRow = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    insert.run("failed-session", 3, goodRow, "failed", JSON.stringify({
      type: "message", message: { role: "assistant", content: [{ type: "text", text: "failed" }], usage: usage(150), stopReason: "error", timestamp: 2 },
    }));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("failed-session", "good-usage", 2, "good", JSON.stringify(usage(40)));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("failed-session", "failed-usage", 4, "failed", JSON.stringify(usage(150)));
    db.query("INSERT INTO pi_values (session_id,namespace,key,seq,value_json) VALUES (?,?,?,?,?)")
      .run("failed-session", "pi.branch.tip", "main", 5, JSON.stringify("failed"));

    expect(await buildSessionContextSnapshot("failed-session", { contextWindow: 200, reserveTokens: 20 }))
      .toMatchObject({ usedTokens: 40, measurement: "exact" });
  });

  test("estimates retained Reins inputs in replacement context after compaction", async () => {
    const project = createProject("Retained input", "/tmp/retained-input");
    createSession("retained-input-session", project.id, { agentRuntimeType: "pi" });
    const db = getDb();
    const retainedInput = {
      role: "reinsInput",
      content: [{ type: "text" as const, text: "retained follow up question" }],
      reinsId: "retained-input",
      metadata: {},
      timestamp: 2,
    };
    db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, 1, NULL, 'compact', 'compaction', ?, datetime('now'))`,
    ).run("retained-input-session", JSON.stringify({
      type: "compaction",
      summary: "Short summary",
      retainedTail: [retainedInput],
      tokensBefore: 120,
      timestamp: 3,
      fromHook: false,
    }));
    db.query("INSERT INTO pi_values (session_id,namespace,key,seq,value_json) VALUES (?,?,?,?,?)")
      .run("retained-input-session", "pi.branch.tip", "main", 2, JSON.stringify("compact"));

    const expected = estimateTokens(createCompactionSummaryMessage("Short summary", 120, 3))
      + estimateTokens({ role: "user", content: retainedInput.content, timestamp: retainedInput.timestamp });

    expect(await buildSessionContextSnapshot("retained-input-session", { contextWindow: 200, reserveTokens: 20 }))
      .toMatchObject({ usedTokens: expected, measurement: "estimated" });
  });

  test("estimates the new active context after compaction instead of reusing pre-compaction usage", async () => {
    const project = createProject("Compacted", "/tmp/compacted");
    createSession("compacted-session", project.id, { agentRuntimeType: "pi" });
    const db = getDb();
    db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, 1, NULL, 'assistant-before', 'assistant', ?, datetime('now'))`,
    ).run("compacted-session", JSON.stringify({
      type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }], usage: usage(120), stopReason: "stop", timestamp: 1 },
    }));
    const assistantRow = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    const compacted = { type: "compaction", summary: "Short summary", retainedTail: [], tokensBefore: 120, fromHook: false };
    db.query(
      `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
       VALUES (?, 3, ?, 'compact', 'compaction', ?, datetime('now'))`,
    ).run("compacted-session", assistantRow, JSON.stringify(compacted));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("compacted-session", "assistant-usage", 2, "assistant-before", JSON.stringify(usage(120)));
    db.query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
      .run("compacted-session", "summary-request-usage", 4, null, JSON.stringify(usage(700)));
    db.query("INSERT INTO pi_values (session_id,namespace,key,seq,value_json) VALUES (?,?,?,?,?)")
      .run("compacted-session", "pi.branch.tip", "main", 5, JSON.stringify("compact"));

    const expected = estimateTokens(createCompactionSummaryMessage("Short summary", 120, 0));
    const snapshot = await buildSessionContextSnapshot("compacted-session", { contextWindow: 200, reserveTokens: 20 });

    expect(snapshot).toEqual({
      usedTokens: expected,
      contextWindow: 200,
      compactionThresholdTokens: 180,
      utilization: expected / 200,
      measurement: "estimated",
    });
    expect(snapshot.usedTokens).not.toBe(120);
    expect(snapshot.usedTokens).not.toBe(700);
  });
});
