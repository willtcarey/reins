import assert from "node:assert/strict";
import { enqueueInput, getNodeCommand, pendingInputs } from "../../nodes/node-command-store.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { drainCommands } from "../helpers/loopback-node.js";
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { nodeSession } from "../helpers/node-session.js";
import { loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { getDb } from "../../db.js";
import { type Project } from "../../project-store.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { getSessionAttachment } from "../../session-attachments-store.js";
import { storedInput } from "../../pi-session-store.js";
import { Sessions } from "../../models/sessions.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";

function writeUInt32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function pngBytes(width = 640, height = 480): Buffer {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  writeUInt32BE(bytes, 16, width);
  writeUInt32BE(bytes, 20, height);
  return Buffer.from(bytes);
}

function imageFile(bytes: Buffer, name = "screen.png", type = "image/png"): File {
  const body = new Uint8Array(bytes.length);
  body.set(bytes);
  return new File([body], name, { type });
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

describe("Sessions.setModel", () => {
  useTestDb();

  let project: Project;
  let broadcastSpy: ReturnType<typeof mock<(msg: ServerMessage) => void>>;
  let broadcast: Broadcast;
  let model: Sessions;

  beforeEach(() => {
    project = createProject("Test Project", "/tmp/test-project", "main");
    broadcastSpy = mock<(msg: ServerMessage) => void>();
    broadcast = broadcastSpy;
    model = new Sessions(createServerState().nodes, broadcast);
  });

  test("queues the change for the session's node, persists metadata, and broadcasts a session update", async () => {
    createSession("sess-1", project.id, {  agentRuntimeType: "pi",thinkingLevel: "medium" });

    const result = await model.setModel({
      sessionId: "sess-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      thinkingLevel: "high",
    });

    expect(getDb().query<{ op: string }, []>("SELECT json_extract(command_json, '$.op') op FROM node_command_outbox WHERE session_id = 'sess-1' ORDER BY rowid").all())
      .toEqual([{ op: "session.setModel" }]);

    const updated = getSession("sess-1");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-5");
    expect(updated!.thinking_level).toBe("high");
    expect(result.model_provider).toBe("anthropic");
    expect(result.model_id).toBe("claude-sonnet-4-5");
    expect(result.thinking_level).toBe("high");

    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "session_updated",
      sessionId: "sess-1",
      projectId: project.id,
    });
  });

  test("updates an inactive session in the DB and broadcasts a session update", async () => {
    createSession("sess-2", project.id, {  agentRuntimeType: "pi",thinkingLevel: "low" });

    const result = await model.setModel({
      sessionId: "sess-2",
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    const updated = getSession("sess-2");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-5");
    expect(updated!.thinking_level).toBe("low");
    expect(result.thinking_level).toBe("low");
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "session_updated",
      sessionId: "sess-2",
      projectId: project.id,
    });
  });

  test("throws when the session does not belong to the project", async () => {
    const otherProject = createProject("Other Project", "/tmp/other-project", "main");
    createSession("sess-3", otherProject.id, { agentRuntimeType: "pi" });

    await expect(
      model.setModel({
        sessionId: "sess-3",
        projectId: project.id,
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
    ).rejects.toThrow(/not found/);
  });

  test("throws for invalid thinking level", async () => {
    createSession("sess-4", project.id, { agentRuntimeType: "pi" });

    await expect(
      model.setModel({
        sessionId: "sess-4",
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "invalid-level",
      }),
    ).rejects.toThrow(/Invalid thinking level/);
  });

  test("message pages strip leading <skill> blocks from user messages", () => {
    createSession("sess-skills", project.id, { agentRuntimeType: "pi" });
    const skillBlock = `<skill name="dip" path="/tmp/dip/SKILL.md">\ndip body\n</skill>`;
    persistCanonicalMessages("sess-skills", [
      {
        role: "user",
        content: [{ type: "text", text: `${skillBlock}\n\n/dip start` }],
      },
      {
        role: "user",
        content: textContent("just text"),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `${skillBlock}\n\nkeep me` }],
      },
    ]);

    const messages = model.getMessagePage("sess-skills", 10)!.items.map(item => item.message);
    expect(messages).toHaveLength(3);

    const msg0Blocks = messages[0]!.content;
    assert(Array.isArray(msg0Blocks) && msg0Blocks[0]!.type === "text");
    expect(msg0Blocks[0].text).toBe("/dip start");
    const msg1Blocks = messages[1]!.content;
    assert(Array.isArray(msg1Blocks) && msg1Blocks[0]!.type === "text");
    expect(msg1Blocks[0].text).toBe("just text");
    // Assistant messages are not stripped.
    const msg2Blocks = messages[2]!.content;
    assert(Array.isArray(msg2Blocks) && msg2Blocks[0]!.type === "text");
    expect(msg2Blocks[0].text).toBe(`${skillBlock}\n\nkeep me`);
  });

  test("rejects models the catalog does not know", async () => {
    createSession("sess-5", project.id, { agentRuntimeType: "pi", thinkingLevel: "low" });

    await expect(
      model.setModel({
        sessionId: "sess-5",
        provider: "claude-agent-sdk",
        modelId: "claude-opus-4-5",
      }),
    ).rejects.toThrow("Model 'claude-opus-4-5' not found for provider 'claude-agent-sdk'");
  });

  test("a model change is delivered in outbox order, after earlier input and before later input; without a thinking level it leaves Pi's level alone", async () => {
    createSession("node", project.id, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
    const state = createServerState();
    const node = useFakeNode(state);
    const before = enqueueInput("node", "prompt", textContent("hi"), "before")!;
    let wakes = 0;
    const sessions = new Sessions({ get: nodeId => state.nodes.get(nodeId), wake: async () => { wakes++; } }, broadcast);
    // Returns the updated row at once; the node applies the change when the command is delivered.
    const row = await sessions.setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "high" });
    expect(row).toMatchObject({ model_provider: "anthropic", model_id: "claude-haiku-4-5", thinking_level: "high" });
    expect(wakes).toBe(1);
    const after = enqueueInput("node", "steer", textContent("hi"), "after")!;
    await drainCommands(state);
    expect(node.sent).toEqual([
      expect.objectContaining({ op: "session.prompt", clientId: "before" }),
      { op: "session.setModel", sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "high" },
      expect.objectContaining({ op: "session.steer", clientId: "after" }),
    ]);
    expect([getNodeCommand(before), getNodeCommand(after)]).toEqual([null, null]);

    await sessions.setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-sonnet-4-5" });
    await drainCommands(state);
    expect(node.sent.at(-1)).toEqual({ op: "session.setModel", sessionId: "node", provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  test("a model change the node rejects is a failed command, reported to every client viewing the session", async () => {
    createSession("node", project.id, { agentRuntimeType: "pi" });
    const state = createServerState();
    const sent: Array<{ type: string; sessionId?: string; error?: string; projectId?: number }> = [];
    state.clients.add({ ws: { send: data => { sent.push(JSON.parse(data)); return 0; } } });
    useFakeNode(state).rejectWhen(command => command.op === "session.setModel" ? `Model not found: ${command.provider}/${command.modelId}` : null);
    await new Sessions(state.nodes).setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5" });
    await drainCommands(state);
    expect(sent).toContainEqual({ type: "error", sessionId: "node", error: "Model change failed: Model not found: anthropic/claude-haiku-4-5" });
    expect(sent).toContainEqual({ type: "session_updated", sessionId: "node", projectId: project.id });
    // Like other failed commands, it is removed after notification so later work can proceed.
    expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = 'node'").get()).toBeNull();
  });
});

describe("Sessions.uploadAttachments", () => {
  useTestDb();

  let project: Project;
  let model: Sessions;

  beforeEach(() => {
    project = createProject("Attachment Model Project", "/tmp/attachment-model-project", "main");
    model = new Sessions(createServerState().nodes);
  });

  test("reads file bytes after validating the session and stores measured dimensions", async () => {
    createSession("sess-upload", project.id, { agentRuntimeType: "pi" });
    const bytes = pngBytes(321, 123);
    const file = imageFile(bytes);
    const readBytes = mock(file.arrayBuffer.bind(file));
    Object.defineProperty(file, "arrayBuffer", { value: readBytes });

    const attachments = await model.uploadAttachments("sess-upload", [file]);

    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(attachments[0]).toMatchObject({
      filename: "screen.png",
      byteSize: bytes.length,
      width: 321,
      height: 123,
    });

    const stored = getSessionAttachment("sess-upload", attachments[0]!.id);
    expect(stored?.data?.toString("hex")).toBe(bytes.toString("hex"));
  });

  test("does not read file bytes when the session is missing", async () => {
    const readBytes = mock(async () => {
      throw new Error("Upload bytes should not be read");
    });
    const file = imageFile(pngBytes());
    Object.defineProperty(file, "arrayBuffer", { value: readBytes });

    await expect(model.uploadAttachments("missing-session", [file])).rejects.toThrow("Session not found");
    expect(readBytes).not.toHaveBeenCalled();
  });
});

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("Sessions.submit", () => {
  useTestDb();

  test("submission wakes delivery once the enclosing transaction commits; a rolled-back submission queues nothing and its wake finds nothing", async () => {
    const project = createProject("targets", "/tmp/targets");
    createSession("node", project.id, { agentRuntimeType: "pi" });
    // What each wake's scan finds pending.
    const scans: string[][] = [];
    const nodes = createServerState().nodes;
    spyOn(nodes, "wake").mockImplementation(async () => { scans.push(pendingInputs("node").map(input => input.clientId)); });
    const sessions = new Sessions(nodes);
    const prompt = (clientId: string) => ({ op: "prompt" as const, content: text("hi"), clientId });

    getDb().transaction(() => {
      sessions.submit("node", prompt("committed"));
      expect(scans).toEqual([]);
    })();
    await Bun.sleep(0);
    expect(scans).toEqual([["committed"]]);

    expect(() => getDb().transaction(() => {
      sessions.submit("node", prompt("rolled-back"));
      throw new Error("rollback");
    })()).toThrow("rollback");
    await Bun.sleep(0);
    expect(scans).toEqual([["committed"], ["committed"]]);

    // The session's source is validated before anything is queued.
    expect(() => sessions.submit("missing", prompt("nowhere"))).toThrow("Session not found: missing");
    await Bun.sleep(0);
    expect(scans).toHaveLength(2);
  });
});

test("input for a session runs on the node of its source, and the delivered input leaves the outbox", async () => {
  const { db, state, untilSettled, replies, dispose } = await nodeSession("session-input", [fauxAssistantMessage("Hello")]);
  try {
    const sessions = new Sessions(state.nodes);
    expect(sessions.get("s")?.placement).toEqual({ available: true, nodeId: "internal", nodeName: "Internal", path: "/tmp/node-commands" });
    sessions.submit("s", { op: "prompt", content: text("Hi"), clientId: "c1" });
    await untilSettled(1);
    expect(replies()).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(storedInput("s", "c1")).toMatchObject({ seq: expect.any(Number) });
    // A replay of the admitted input is recognized from the server's storage and queues nothing.
    sessions.submit("s", { op: "prompt", content: text("Hi"), clientId: "c1" });
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { await dispose(); }
}, 15_000);

describe("Sessions.abort / Sessions.resume", () => {
  useTestDb();

  test("call the session's node at once and are never queued: an offline node is `unavailable`, a refusal is the node's NodeError", async () => {
  const project = createProject("targets", "/tmp/targets");
  createSession("node", project.id, { agentRuntimeType: "pi" });
  const state = createServerState();
  await expect(new Sessions(state.nodes).abort("node")).rejects.toMatchObject({
    message: "Node unavailable: Node not connected", error: { code: "unavailable", message: "Node unavailable: Node not connected", retryable: true } });
  const node = useFakeNode(state);
  await node.link.ready();
  expect(await new Sessions(state.nodes).abort("node")).toEqual({ aborted: false });
  expect(await new Sessions(state.nodes).resume("node")).toEqual({ started: true });
  expect(node.sent).toEqual([{ op: "session.abort", sessionId: "node" }, { op: "session.resumePending", sessionId: "node" }]);
  node.reject("session.resumePending", "nothing to resume");
  await expect(new Sessions(state.nodes).resume("node")).rejects.toMatchObject({
    message: "nothing to resume", error: { code: "invalid_request", message: "nothing to resume", retryable: false } });
  await expect(new Sessions(state.nodes).abort("missing")).rejects.toThrow("Session not found: missing");
  expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  });
});

test("over a real node, abort stops a running run, and with nothing running answers so without starting anything; nothing pending to resume is the node's refusal", async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { db, state, untilSettled, dispose } = await nodeSession("abort-session", [
    (_context, options) => new Promise(resolve => {
      started();
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" })), { once: true });
    }),
  ]);
  try {
    expect(await new Sessions(state.nodes).abort("s")).toEqual({ aborted: false });
    await expect(new Sessions(state.nodes).resume("s")).rejects.toMatchObject({
      error: { code: "internal", message: "Lane 'main' has no pending inactive operation", retryable: false } });
    new Sessions(state.nodes).submit("s", { op: "prompt", content: text("Work"), clientId: "long" });
    await running;
    expect(await new Sessions(state.nodes).abort("s")).toEqual({ aborted: true });
    await untilSettled(1);
    expect(db.query("SELECT settlement_json FROM sessions WHERE id = 's'").get()).toMatchObject({ settlement_json: expect.stringContaining('"status":"aborted"') });
  } finally { await dispose(); }
}, 15_000);

test("a direct call whose outcome is unknown (its link dropped) fails to its caller as `unavailable` and is not retried", async () => {
  const { state, dispose } = await nodeSession("call-unknown");
  try {
    const resumes = spyOn(loopbackNodeFor(state), "resumePending").mockReturnValue(new Promise(() => {}));
    const pending = new Sessions(state.nodes).resume("s");
    for (let i = 0; i < 200 && resumes.mock.calls.length === 0; i++) await Bun.sleep(5);
    await stopLoopbackNode(state);
    await expect(pending).rejects.toMatchObject({
      error: { code: "unavailable", message: "Node unavailable: Connection closed; outcome unknown", retryable: true } });
    expect(resumes).toHaveBeenCalledTimes(1);
    expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { await dispose(); }
});
