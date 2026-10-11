import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { handleWsMessage } from "../ws.js";
import { createServerState } from "./helpers/server-state.js";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "./project-fixture.js";
import { createSession } from "./session-fixture.js";
import { storeSessionAttachment } from "../session-attachments-store.js";
import { getDb } from "../db.js";
import type { ServerState } from "../state.js";
import { storedInput } from "../pi-session-store.js";
import { latestSettlement } from "../sessions/session-runs.js";
import { useFakeModel } from "./helpers/fake-model.js";
import { useTestRepo } from "./helpers/test-repo.js";
import { connectLoopbackNode, stopLoopbackNode } from "./helpers/loopback-node.js";

/**
 * Minimal mock WebSocket that captures sent messages.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
}
/** Every viewer also gets session events and session and node updates; a sender's replies are the rest. */
function replies(socket: ReturnType<typeof createMockWs>) {
  return socket.allMessages().filter(sent => !["event", "session_updated", "node_updated", "node_removed"].includes(sent.type)).at(-1);
}
/** The content Pi admitted for `sessionId` under `reinsId`. */
function admittedContent(sessionId: string, reinsId: string): unknown {
  const row = getDb().query<{ content: string }, [string, string]>("SELECT json_extract(message_json, '$.message.content') content FROM session_messages WHERE session_id = ? AND role = 'reinsInput' AND json_extract(message_json, '$.message.reinsId') = ?").get(sessionId, reinsId);
  return row ? JSON.parse(row.content) : null;
}

function createMockWs() {
  const sent: string[] = [];
  return {
    ws: {
      send(data: string) {
        sent.push(data);
        return data.length;
      },
    },
    sent,
    /** Parse the last sent message as JSON */
    lastMessage(): any {
      if (sent.length === 0) return null;
      return JSON.parse(sent[sent.length - 1]);
    },
    /** Parse all sent messages as JSON */
    allMessages(): any[] {
      return sent.map((s) => JSON.parse(s));
    },
  };
}



describe("WebSocket handlers", () => {
  let state: ServerState;

  beforeEach(() => {
    state = createServerState();
  });

  describe("handleWsMessage — validation errors", () => {
    test("invalid JSON sends error message", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(state, mock.ws, "not valid json{{{");

      // handleWsMessage dispatches async, give it a tick
      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Invalid JSON",
      });
    });

    test("missing sessionId sends error message", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(state, mock.ws, JSON.stringify({ type: "prompt", message: "hello" }));

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Missing sessionId",
      });
    });

    test("unknown command sends error message", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "nonexistent_command", sessionId: "sess-1" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        sessionId: "sess-1",
        error: "Unknown command: nonexistent_command",
      });
    });
  });

  describe("handleWsMessage — abort for non-active session", () => {
    test("abort with no active session sends error", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "abort", sessionId: "nonexistent-session" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        sessionId: "nonexistent-session",
        error: "Session not active",
      });
    });
  });

  describe("handleWsMessage — Buffer input", () => {
    test("handles Buffer message (converted to string internally)", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      const buf = Buffer.from("not json");
      handleWsMessage(state, mock.ws, buf);

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Invalid JSON",
      });
    });
  });

  describe("handleWsMessage — ping/pong heartbeat", () => {
    test("ping message receives pong response", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(state, mock.ws, JSON.stringify({ type: "ping" }));

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({ type: "pong" });
    });

    test("ping does not require sessionId", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(state, mock.ws, JSON.stringify({ type: "ping" }));

      await Bun.sleep(10);

      const messages = mock.allMessages();
      // Should get pong, not an error about missing sessionId
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("pong");
    });
  });

  describe("handleWsMessage — prompt/steer missing message field", () => {
    test("prompt without message field sends session-scoped error", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "prompt", sessionId: "sess-1" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        sessionId: "sess-1",
        error: "Missing message field",
      });
    });

    test("steer without message field sends error", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "steer", sessionId: "sess-1" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        sessionId: "sess-1",
        error: "Missing message field",
      });
    });

    test("prompt with a message but no submission identity is rejected", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "prompt", sessionId: "sess-1", message: [{ type: "text", text: "hello" }] }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        sessionId: "sess-1",
        error: "Missing clientId",
      });
    });

    test("prompt with non-block message sends validation error before session lookup", async () => {
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "prompt", sessionId: "missing-session", clientId: "request-1", message: "hello" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        sessionId: "missing-session",
        clientId: "request-1",
        error: "Invalid message field: expected content blocks array",
      });
    });

  });

  describe("handleWsMessage — submission to the session's runtime", () => {
    useTestDb();
    const repo = useTestRepo();
    const model = useFakeModel();
    beforeEach(() => { connectLoopbackNode(state); });
    afterEach(() => stopLoopbackNode(state));
    const newSession = (id: string, modelId = model.model.modelId) => {
      const project = createProject(`WS ${id}`, repo.dir);
      createSession(id, project.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId });
    };

    test("acknowledges a steer by client id once Pi committed it, to the sender only", async () => {
      newSession("sess-steer");
      const sender = createMockWs();
      const observer = createMockWs();
      state.clients.add({ ws: sender.ws });
      state.clients.add({ ws: observer.ws });
      const message = [{ type: "text" as const, text: "keep going" }];

      handleWsMessage(state, sender.ws, JSON.stringify({ type: "steer", sessionId: "sess-steer", clientId: "submission-steer", message }));
      await until(() => replies(sender)?.type === "ack");

      expect(replies(sender)).toEqual({ type: "ack", command: "steer", clientId: "submission-steer" });
      expect(storedInput("sess-steer", "submission-steer")).not.toBeNull();
      expect(observer.allMessages().some(sent => sent.type === "ack")).toBe(false);
      // A replay under the same client id (the browser resends what it saw no ack for) is acknowledged again.
      handleWsMessage(state, sender.ws, JSON.stringify({ type: "steer", sessionId: "sess-steer", clientId: "submission-steer", message }));
      await until(() => sender.allMessages().filter(sent => sent.type === "ack").length === 2);
      expect(getDb().query("SELECT COUNT(*) n FROM session_messages WHERE session_id = 'sess-steer' AND role = 'reinsInput'").get()).toEqual({ n: 1 });
    });

    test("a submission's failure is its answer, to the submitting socket only", async () => {
      newSession("sess-failure", "missing");
      const sender = createMockWs();
      const observer = createMockWs();
      state.clients.add({ ws: sender.ws });
      state.clients.add({ ws: observer.ws });
      handleWsMessage(state, sender.ws, JSON.stringify({ type: "steer", sessionId: "sess-failure", clientId: "failure-id", message: [{ type: "text", text: "hello" }] }));
      await until(() => replies(sender)?.type === "error");
      expect(replies(sender)).toEqual({ type: "error", sessionId: "sess-failure", clientId: "failure-id", error: `steer failed: Model not found: ${model.model.provider}/missing` });
      expect(sender.allMessages().some(sent => sent.type === "ack")).toBe(false);
      expect(observer.allMessages().some(sent => sent.type === "error")).toBe(false);
    });

    test("input for a session whose node was removed is refused at once, saying why", async () => {
      getDb().exec("INSERT INTO nodes (id, name, public_key) VALUES ('gone', 'Gone', 'key')");
      const project = createProject("WS removed", "/tmp/ws-removed", "main", "gone");
      createSession("sess-removed", project.id, { agentRuntimeType: "pi" });
      getDb().exec("UPDATE nodes SET removed_at = '2026-10-11T09:00:00.000Z' WHERE id = 'gone'");
      const sender = createMockWs();
      state.clients.add({ ws: sender.ws });

      handleWsMessage(state, sender.ws, JSON.stringify({ type: "prompt", sessionId: "sess-removed", clientId: "removed-id", message: [{ type: "text", text: "hello" }] }));
      await until(() => replies(sender)?.type === "error");

      expect(replies(sender)).toEqual({ type: "error", sessionId: "sess-removed", clientId: "removed-id", error: "prompt failed: This session's node was removed; move it to another node to continue" });
    });

    test("abort acknowledges, and aborts the session's run in its live runtime; with none it does nothing", async () => {
      newSession("sess-abort");
      const mock = createMockWs();
      state.clients.add({ ws: mock.ws });
      handleWsMessage(state, mock.ws, JSON.stringify({ type: "abort", sessionId: "sess-abort" }));
      await until(() => mock.allMessages().length > 0);
      expect(mock.allMessages()).toEqual([{ type: "ack", command: "abort" }]);
      expect(state.sessions.live.size).toBe(0);

      handleWsMessage(state, mock.ws, JSON.stringify({ type: "prompt", sessionId: "sess-abort", clientId: "long", message: [{ type: "text", text: "Work" }] }));
      await model.nextTurn("sess-abort");
      handleWsMessage(state, mock.ws, JSON.stringify({ type: "abort", sessionId: "sess-abort" }));
      await until(() => latestSettlement("sess-abort") !== null);
      expect(latestSettlement("sess-abort")).toMatchObject({ status: "aborted" });
    });

    test("validates attachment refs and submits them as Pi admits them", async () => {
      newSession("sess-ws");
      const attachment = storeSessionAttachment("sess-ws", {
        data: Buffer.from("runtime image bytes"),
        mimeType: "image/png",
        filename: "screen.png",
        width: 320,
        height: 200,
      });
      const message = [
        { type: "text" as const, text: "look at this" },
        {
          type: "image" as const,
          attachmentId: attachment.id,
          mimeType: attachment.mimeType,
          filename: attachment.filename,
          byteSize: attachment.byteSize,
          sha256: attachment.sha256,
          width: attachment.width,
          height: attachment.height,
        },
      ];
      const sender = createMockWs();
      state.clients.add({ ws: sender.ws });

      handleWsMessage(state, sender.ws, JSON.stringify({ type: "prompt", sessionId: "sess-ws", clientId: "submission-prompt", message }));
      await until(() => replies(sender)?.type === "ack");

      expect(replies(sender)).toEqual({ type: "ack", command: "prompt", clientId: "submission-prompt" });
      expect(admittedContent("sess-ws", "submission-prompt")).toEqual(message);
    });
  });
});
