import assert from "node:assert/strict";
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { closeSessions, createAppState, useLoopbackState } from "../helpers/app-state.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { until } from "../helpers/session-host.js";
import { getDb } from "../../db.js";
import { type Project } from "../../project-store.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { getSessionAttachment } from "../../session-attachments-store.js";
import { storedInput } from "../../pi-session-store.js";
import { PiStorageAdapter } from "../../pi-storage.js";
import { Sessions } from "../../models/sessions.js";
import { latestSettlement } from "../../sessions/session-runs.js";
import { sessionActivity } from "../../models/session-activity.js";
import { storedLaneModel } from "../../session-runtime/lane.js";
import { openSessionRuntime } from "../../session-runtime/live.js";
import type { ServerMessage } from "../../models/broadcast.js";
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

function textContent(value: string) {
  return [{ type: "text" as const, text: value }];
}

const text = (value: string) => [{ type: "text" as const, text: value }];
/** Pi's main lane's model selection, as stored. */
const laneModel = (sessionId: string) => storedLaneModel(new PiStorageAdapter(getDb(), sessionId));
/** How many inputs Pi holds under `reinsId` in the session's transcript. */
const admitted = (sessionId: string, reinsId: string) => getDb().query<{ n: number }, [string, string]>(
  "SELECT COUNT(*) n FROM session_messages WHERE session_id = ? AND role = 'reinsInput' AND json_extract(message_json, '$.message.reinsId') = ?").get(sessionId, reinsId)!.n;

describe("Sessions on the server's runtimes", () => {
  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  const model = useFakeModel();
  let project: Project;
  let broadcastSpy: ReturnType<typeof mock<(msg: ServerMessage) => void>>;
  let sessions: Sessions;

  beforeEach(() => {
    project = createProject("Runtime", repo.dir);
    broadcastSpy = mock<(msg: ServerMessage) => void>();
    sessions = new Sessions(loopback.state, broadcastSpy);
  });

  const newSession = (id: string, options: { modelId?: string } = {}) =>
    createSession(id, project.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: options.modelId ?? model.model.modelId });

  describe("submit", () => {
    test("resolves once Pi committed the input under its clientId; a replay converges on it and resolves again", async () => {
      newSession("s");
      await sessions.submit("s", { op: "prompt", content: text("Hello"), clientId: "c1" });
      expect(storedInput("s", "c1")).toEqual({ seq: expect.any(Number) });
      (await model.nextTurn("s")).finish({ reply: "Hi" });
      await until(() => latestSettlement("s")?.status === "completed", "the run settled");

      await sessions.submit("s", { op: "prompt", content: text("Hello"), clientId: "c1" });
      expect(admitted("s", "c1")).toBe(1);
      expect(model.turns).toHaveLength(1);
    });

    test("a session's submissions apply in the order they arrived, model changes included", async () => {
      newSession("s");
      /** Answers the session's requests until it is idle. */
      const settle = async () => {
        const answered = new Set<unknown>();
        while (sessionActivity(getSession("s")!, loopback.state.process.sessions) !== "idle") {
          const turn = model.turns.find(candidate => candidate.sessionId === "s" && !answered.has(candidate));
          if (turn) { answered.add(turn); turn.finish(); } else await Bun.sleep(5);
        }
      };
      // Submitted together, before the session's runtime is open.
      await Promise.all([
        sessions.submit("s", { op: "prompt", content: text("first"), clientId: "first" }),
        sessions.submit("s", { op: "steer", content: text("second"), clientId: "second" }),
        sessions.submit("s", { op: "steer", content: text("third"), clientId: "third" }),
      ]);
      await settle();
      const seqs = ["first", "second", "third"].map(id => storedInput("s", id)).map(input => input && "seq" in input ? input.seq : -1);
      expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
      expect(seqs).not.toContain(-1);

      // A model change ahead of a prompt applies before it.
      await Promise.all([
        sessions.setModel({ sessionId: "s", provider: model.model.provider, modelId: "other" }),
        sessions.submit("s", { op: "prompt", content: text("fourth"), clientId: "fourth" }),
      ]);
      expect((await model.nextTurn("s")).modelId).toBe("other");
      await settle();
    });

    test("a failure is the submission's own: a model the server's catalog does not have", async () => {
      newSession("s", { modelId: "missing" });
      await expect(sessions.submit("s", { op: "prompt", content: text("Hello"), clientId: "c1" })).rejects.toThrow(`Model not found: ${model.model.provider}/missing`);
      expect(storedInput("s", "c1")).toBeNull();
      // The chain goes on: the next submission is not held up by the failed one.
      getDb().query("UPDATE sessions SET model_id = 'fake' WHERE id = 's'").run();
      await sessions.submit("s", { op: "prompt", content: text("Hello"), clientId: "c2" });
      expect(storedInput("s", "c2")).not.toBeNull();
    });

    test("refuses content too large to submit, and a session that is gone, before submitting anything", async () => {
      newSession("s");
      // Two blocks under the per-block limit whose JSON is over 8 MiB.
      const content = [...text("x".repeat(4 * 1024 * 1024)), ...text("x".repeat(4 * 1024 * 1024))];
      for (const op of ["prompt", "steer"] as const) {
        await expect(sessions.submit("s", { op, content, clientId: op })).rejects.toThrow("Prompt too large: 8.0 MiB of content; the most a prompt can carry is 8 MiB");
      }
      await expect(sessions.submit("missing", { op: "prompt", content: text("hi"), clientId: "c" })).rejects.toThrow("Session not found: missing");
      expect(loopback.state.process.sessions.live.size).toBe(0);
    });
  });

  describe("setModel", () => {
    test("sets the model through the session's runtime (seeding a lane Pi has not created with it), then the row, and broadcasts", async () => {
      newSession("s");
      const row = await sessions.setModel({ sessionId: "s", provider: model.model.provider, modelId: "other", thinkingLevel: "high" });
      expect(await laneModel("s")).toEqual({ provider: model.model.provider, modelId: "other", thinkingLevel: "high" });
      expect(row).toMatchObject({ model_provider: model.model.provider, model_id: "other", thinking_level: "high" });
      expect(broadcastSpy).toHaveBeenCalledWith({ type: "session_updated", sessionId: "s", projectId: project.id });

      // Without a thinking level, Pi's level stays.
      await sessions.setModel({ sessionId: "s", provider: model.model.provider, modelId: "fake" });
      expect(await laneModel("s")).toEqual({ provider: model.model.provider, modelId: "fake", thinkingLevel: "high" });
      expect(getSession("s")).toMatchObject({ model_id: "fake", thinking_level: "high" });
    });

    test("repairs a lane whose model is gone: the runtime opens with the new one", async () => {
      newSession("s");
      await sessions.setModel({ sessionId: "s", provider: model.model.provider, modelId: "other" });
      await closeSessions(loopback.state.process);
      getDb().query("UPDATE pi_values SET value_json = json_set(value_json, '$.model.modelId', 'retired') WHERE session_id = 's' AND namespace = 'pi.lane.config'").run();
      await expect(sessions.submit("s", { op: "prompt", content: text("Hi"), clientId: "c" })).rejects.toThrow("Model not found");

      await sessions.setModel({ sessionId: "s", provider: model.model.provider, modelId: "fake" });
      expect(await laneModel("s")).toMatchObject({ modelId: "fake" });
    });

    test("a failure applying it is the request's error: the row keeps its model and nothing is broadcast", async () => {
      newSession("s");
      const runtime = await openSessionRuntime(loopback.state.process, "s");
      spyOn(runtime, "setModel").mockRejectedValue(new Error("lane write failed"));
      await expect(sessions.setModel({ sessionId: "s", provider: model.model.provider, modelId: "other" })).rejects.toThrow("lane write failed");
      expect(getSession("s")).toMatchObject({ model_id: "fake" });
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test("validates against the server's catalog, the session's project and the thinking level first", async () => {
      newSession("s");
      await expect(sessions.setModel({ sessionId: "s", provider: "claude-agent-sdk", modelId: "claude-opus-4-5" }))
        .rejects.toThrow("Model 'claude-opus-4-5' not found for provider 'claude-agent-sdk'");
      await expect(sessions.setModel({ sessionId: "s", projectId: project.id + 1, provider: model.model.provider, modelId: "other" })).rejects.toThrow(/not found/);
      await expect(sessions.setModel({ sessionId: "s", provider: model.model.provider, modelId: "other", thinkingLevel: "invalid-level" })).rejects.toThrow(/Invalid thinking level/);
      expect(loopback.state.process.sessions.live.size).toBe(0);
    });
  });

  describe("abort and resume", () => {
    test("abort acts on the live runtime: without one it opens nothing and answers false; a running run is aborted", async () => {
      newSession("s");
      expect(await sessions.abort("s")).toEqual({ aborted: false });
      expect(loopback.state.process.sessions.live.size).toBe(0);
      await sessions.submit("s", { op: "prompt", content: text("Work"), clientId: "long" });
      await model.nextTurn("s");
      expect(await sessions.abort("s")).toEqual({ aborted: true });
      await until(() => latestSettlement("s") !== null, "the run settled");
      expect(latestSettlement("s")).toMatchObject({ status: "aborted" });
      expect(await sessions.abort("s")).toEqual({ aborted: false });
      await expect(sessions.abort("missing")).rejects.toMatchObject({ name: "SessionNotFoundError" });
    });

    test("resume drives a run a suspended runtime left pending, in a new runtime; with nothing pending it starts nothing", async () => {
      newSession("s");
      expect(await sessions.resume("s")).toEqual({ started: false });
      await sessions.submit("s", { op: "prompt", content: text("Work"), clientId: "work" });
      await model.nextTurn("s");
      // A process exit: the runtime is suspended, its run pending in storage.
      const entry = loopback.state.process.sessions.live.get("s")!;
      loopback.state.process.sessions.live.delete("s");
      await entry.runtime.suspend();
      // Nothing drives it: idle, with its operation pending (the Resume button).
      expect(getSession("s")?.activity_state).toBeNull();
      expect(sessions.getDetail("s")?.pendingOperation).toEqual({ kind: "run" });

      expect(await sessions.resume("s")).toEqual({ started: true });
      (await model.nextTurn("s")).finish({ reply: "Resumed" });
      await until(() => latestSettlement("s")?.status === "completed", "the resumed run completed");
      expect(admitted("s", "work")).toBe(1);
    });
  });

  test("moving a session closes its live runtime, bound to the source it left", async () => {
    newSession("s");
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('laptop', 'Laptop')");
    getDb().query("INSERT INTO sources (project_id, node_id, path) VALUES (?, 'laptop', '/laptop/checkout')").run(project.id);
    const runtime = await openSessionRuntime(loopback.state.process, "s");
    const closed = spyOn(runtime, "close");
    expect(await sessions.move("s", "laptop")).toMatchObject({ nodeId: "laptop", path: "/laptop/checkout" });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(loopback.state.process.sessions.live.has("s")).toBe(false);
  });

  test("a session busy admitting input reads running before its run reports started", async () => {
    newSession("s");
    const pending = sessions.submit("s", { op: "prompt", content: text("Work"), clientId: "c" });
    expect(sessions.getDetail("s")).toMatchObject({ pendingOperation: null });
    await expect(sessions.move("s", "internal")).resolves.toBeDefined();
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('laptop', 'Laptop')");
    getDb().query("INSERT INTO sources (project_id, node_id, path) VALUES (?, 'laptop', '/laptop/checkout')").run(project.id);
    await expect(sessions.move("s", "laptop")).rejects.toThrow("Session has an active run or pending input");
    await pending;
  });
});

describe("Sessions for a session whose node was removed", () => {
  useTestDb();

  test("refuses work at once, submitting nothing and keeping its model", async () => {
    getDb().exec("INSERT INTO nodes (id, name, public_key) VALUES ('gone', 'Gone', 'key')");
    const project = createProject("abandoned", "/tmp/abandoned", "main", "gone");
    createSession("stranded", project.id, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
    getDb().exec("UPDATE nodes SET removed_at = '2026-10-11T09:00:00.000Z' WHERE id = 'gone'");
    const state = createAppState();
    const sessions = new Sessions(state, () => {});
    const removed = "This session's node was removed; move it to another node to continue";

    for (const op of ["prompt", "steer"] as const) {
      await expect(sessions.submit("stranded", { op, content: text("hi"), clientId: op })).rejects.toThrow(removed);
    }
    await expect(sessions.setModel({ sessionId: "stranded", provider: "anthropic", modelId: "claude-haiku-4-5" })).rejects.toThrow(removed);
    await expect(sessions.resume("stranded")).rejects.toThrow(removed);
    expect(state.process.sessions.live.size).toBe(0);
    expect(getSession("stranded")).toMatchObject({ model_provider: "anthropic", model_id: "claude-sonnet-4-5" });
  });
});

describe("Sessions views", () => {
  useTestDb();

  let project: Project;
  let model: Sessions;

  beforeEach(() => {
    project = createProject("Test Project", "/tmp/test-project", "main");
    model = new Sessions(createAppState(), () => {});
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

});

describe("Sessions.uploadAttachments", () => {
  useTestDb();

  let project: Project;
  let model: Sessions;

  beforeEach(() => {
    project = createProject("Attachment Model Project", "/tmp/attachment-model-project", "main");
    model = new Sessions(createAppState(), () => {});
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

