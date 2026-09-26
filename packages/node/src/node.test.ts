import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { startNode } from "./node.js";
import { nodeAdmissionReceipt } from "./storage.js";
import { registerPiProvider, unregisterPiProvider } from "./runtime/context.js";
import type { NodeRuntimePolicy } from "./runtime/build.js";

test("opening a session does not fetch attachments from past inputs", async () => {
  const db = new Database(":memory:");
  const node = startNode({ db, deliver: () => {}, prepare: async () => { throw new Error("runtime opened"); },
    fetchAttachment: async () => { throw new Error("historical fetch"); } });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    await node.send({ op: "session.provision", sessionId: "s", sourceId: 7 }, binding);
    db.query(`INSERT INTO session_messages(session_id,seq,harness_id,role,message_json,created_at)
      VALUES(?,?,?,?,?,?)`).run("s", 1, "entry-1", "reinsInput", JSON.stringify({
        type: "message", message: { role: "reinsInput", content: [
          { type: "image", attachmentId: "old", mimeType: "image/png", byteSize: 1 },
        ] },
      }), binding.createdAt);
    await expect(node.open("s", binding)).rejects.toThrow("runtime opened");
    expect(db.query("SELECT 1 FROM node_attachments").get()).toBeNull();
  } finally { node.stop(); db.close(); }
});

test("handler reinstall retains the attachment fetcher for new image prompts", async () => {
  const db = new Database(":memory:");
  const bytes = Buffer.from("abc");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = { db, deliver: () => {}, prepare: async () => { throw new Error("runtime opened"); } };
  const first = startNode({ ...base, fetchAttachment: async () => null });
  let fetches = 0;
  const reinstalled = startNode({ ...base, fetchAttachment: async () => {
    fetches++;
    return { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256 };
  } });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    expect(await reinstalled.send({ op: "session.provision", sessionId: "s", sourceId: 7 }, binding)).toMatchObject({ ok: true });
    await expect(reinstalled.send({ op: "session.prompt", sessionId: "s", clientId: "image", content: [
      { type: "image", attachmentId: "new-image", mimeType: "image/png", byteSize: bytes.length },
    ] }, binding)).rejects.toThrow("runtime opened");
    expect(fetches).toBe(1);
    expect(db.query("SELECT data FROM node_attachments WHERE session_id = ? AND attachment_id = ?").get("s", "new-image"))
      .toEqual({ data: bytes });
  } finally { first.stop(); reinstalled.stop(); db.close(); }
});

test("node provisions an immutable binding, executes Pi and reopens from canonical storage without product tables", async () => {
  const db = new Database(":memory:");
  const provider = fauxProvider({ provider: "node-owner-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("interrupted answer"), fauxAssistantMessage("second")]);
  registerPiProvider(provider.provider);
  const events: string[] = [];
  const credentials: NodeRuntimePolicy["credentials"] = {
    read: async () => ({ type: "api_key", key: "test" }),
    list: async () => [{ providerId: provider.provider.id, type: "api_key" }],
    modify: async () => ({ type: "api_key", key: "test" }),
    delete: async () => {},
  };
  const dependencies = {
    db,
    deliver: () => {},
    prepare: async (): Promise<NodeRuntimePolicy> => ({
      model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null,
      credentials, customTools: [], systemPrompt: () => "Node-owned Pi test",
      lifecycle: { started: () => events.push("started"), settled: () => events.push("settled") },
      observe: event => events.push(event.type),
    }),
  };
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const provision = { op: "session.provision" as const, sessionId: "s", sourceId: 7 };
  try {
    const node = startNode(dependencies);
    expect(await node.send(provision, binding, "provision-command")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(nodeAdmissionReceipt(db, "provision-command")).toEqual({ sessionId: "s", operation: "session.provision", payload: JSON.stringify(provision) });
    expect(await node.send(provision, binding, "provision-command")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('projects', 'sources', 'node_command_outbox')").all()).toEqual([]);
    await expect(node.send(provision, { ...binding, cwd: "/wrong" })).rejects.toThrow("binding mismatch");
    expect(await node.send({ op: "session.prompt", sessionId: "s", clientId: "missing-image", content: [
      { type: "image", attachmentId: "missing", mimeType: "image/png", byteSize: 1 },
    ] }, binding, "missing-image-command")).toMatchObject({ ok: false, error: { code: "invalid_request", retryable: false } });
    expect(nodeAdmissionReceipt(db, "missing-image-command")).toBeNull();
    const input = { op: "session.prompt" as const, sessionId: "s", clientId: "c", content: [{ type: "text" as const, text: "hello" }] };
    expect(await node.send(input, binding, "input-command"))
      .toEqual({ ok: true, value: { kind: "admitted", inputId: "c" } });
    expect(nodeAdmissionReceipt(db, "input-command")).toEqual({ sessionId: "s", operation: "session.prompt", payload: JSON.stringify(input) });
    expect(await node.send(input, binding, "input-command")).toEqual({ ok: true, value: { kind: "admitted", inputId: "c" } });
    const runtime = await node.open("s", binding);
    const reinstalled = startNode(dependencies); // Server handler reload keeps the node process/runtime owner.
    node.stop();
    expect(await reinstalled.open("s", binding)).toBe(runtime);
    await runtime.waitForIdle();
    expect((await runtime.getMessages()).map(message => message.role)).toEqual(["user", "assistant"]);
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON admission_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    const interrupted = { op: "session.steer" as const, sessionId: "s", clientId: "interrupted", content: [{ type: "text" as const, text: "unacknowledged" }] };
    await expect(reinstalled.send(interrupted, binding, "interrupted-command")).rejects.toThrow("receipt unavailable");
    expect(nodeAdmissionReceipt(db, "interrupted-command")).toBeNull();
    expect((await runtime.getMessages()).some(message => message.role === "user" && JSON.stringify(message.content).includes("unacknowledged"))).toBe(true);
    db.exec("DROP TRIGGER reject_receipt");
    await runtime.waitForIdle();
    expect(events).toContain("settled");
    expect(events).toContain("agent_end");
    await reinstalled.close("s");
    reinstalled.stop();

    const restarted = startNode(dependencies);
    expect(await restarted.send({ op: "session.steer", sessionId: "s", clientId: "d", content: [{ type: "text", text: "again" }] }, binding))
      .toEqual({ ok: true, value: { kind: "admitted", inputId: "d" } });
    const reopened = await restarted.open("s", binding);
    await reopened.waitForIdle();
    expect((await reopened.getMessages()).map(message => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    await expect(restarted.send({ op: "session.abort", sessionId: "s" }, { ...binding, cwd: "/other" })).rejects.toThrow("binding mismatch");
    await restarted.close("s");
    restarted.stop();
  } finally { unregisterPiProvider(provider.provider.id); db.close(); }
});
