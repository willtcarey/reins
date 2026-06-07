import { describe, test, expect, beforeEach } from "bun:test";
import { handleWsOpen, handleWsMessage, handleWsClose } from "../ws.js";
import { createServerState } from "./helpers/server-state.js";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import { storeSessionAttachment } from "../session-attachments-store.js";
import { createRuntimeStub } from "./helpers/test-runtime-stub.js";
import type { ServerState } from "../state.js";

/**
 * Minimal mock WebSocket that captures sent messages.
 */
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

  describe("handleWsOpen / handleWsClose — client tracking", () => {
    test("adds client on open", () => {
      const { ws } = createMockWs();
      expect(state.clients.size).toBe(0);

      handleWsOpen(state, ws);

      expect(state.clients.size).toBe(1);
    });

    test("tracks multiple clients", () => {
      const ws1 = createMockWs().ws;
      const ws2 = createMockWs().ws;

      handleWsOpen(state, ws1);
      handleWsOpen(state, ws2);

      expect(state.clients.size).toBe(2);
    });

    test("removes client on close", () => {
      const { ws } = createMockWs();
      handleWsOpen(state, ws);
      expect(state.clients.size).toBe(1);

      handleWsClose(state, ws);

      expect(state.clients.size).toBe(0);
    });

    test("close is idempotent for unknown ws", () => {
      const { ws } = createMockWs();
      // Close without open — should not throw
      handleWsClose(state, ws);
      expect(state.clients.size).toBe(0);
    });

    test("only removes the correct client", () => {
      const ws1 = createMockWs().ws;
      const ws2 = createMockWs().ws;

      handleWsOpen(state, ws1);
      handleWsOpen(state, ws2);
      expect(state.clients.size).toBe(2);

      handleWsClose(state, ws1);
      expect(state.clients.size).toBe(1);
    });
  });

  describe("handleWsMessage — validation errors", () => {
    test("invalid JSON sends error message", async () => {
      const mock = createMockWs();
      handleWsOpen(state, mock.ws);

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
      handleWsOpen(state, mock.ws);

      handleWsMessage(state, mock.ws, JSON.stringify({ type: "prompt", message: "hello" }));

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Missing sessionId",
      });
    });

    test("unknown command sends error message", async () => {
      const mock = createMockWs();
      handleWsOpen(state, mock.ws);

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "nonexistent_command", sessionId: "sess-1" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Unknown command: nonexistent_command",
      });
    });
  });

  describe("handleWsMessage — abort for non-active session", () => {
    test("abort with no active session sends error", async () => {
      const mock = createMockWs();
      handleWsOpen(state, mock.ws);

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "abort", sessionId: "nonexistent-session" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Session not active",
      });
    });
  });

  describe("handleWsMessage — Buffer input", () => {
    test("handles Buffer message (converted to string internally)", async () => {
      const mock = createMockWs();
      handleWsOpen(state, mock.ws);

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
      handleWsOpen(state, mock.ws);

      handleWsMessage(state, mock.ws, JSON.stringify({ type: "ping" }));

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({ type: "pong" });
    });

    test("ping does not require sessionId", async () => {
      const mock = createMockWs();
      handleWsOpen(state, mock.ws);

      handleWsMessage(state, mock.ws, JSON.stringify({ type: "ping" }));

      await Bun.sleep(10);

      const messages = mock.allMessages();
      // Should get pong, not an error about missing sessionId
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("pong");
    });
  });

  describe("handleWsMessage — prompt/steer missing message field", () => {
    test("prompt without message field sends error", async () => {
      const mock = createMockWs();
      handleWsOpen(state, mock.ws);

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "prompt", sessionId: "sess-1" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Missing message field",
      });
    });

    test("steer without message field sends error", async () => {
      const mock = createMockWs();
      handleWsOpen(state, mock.ws);

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "steer", sessionId: "sess-1" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Missing message field",
      });
    });

    test("prompt with non-block message sends validation error before session lookup", async () => {
      const mock = createMockWs();
      handleWsOpen(state, mock.ws);

      handleWsMessage(
        state,
        mock.ws,
        JSON.stringify({ type: "prompt", sessionId: "missing-session", message: "hello" }),
      );

      await Bun.sleep(10);

      expect(mock.lastMessage()).toEqual({
        type: "error",
        error: "Invalid message field: expected content blocks array",
      });
    });

  });

  describe("handleWsMessage — multimodal prompt path", () => {
    useTestDb();

    test("validates and forwards attachment refs to the runtime while broadcasting refs to other clients", async () => {
      const project = createProject("WS Multimodal", "/tmp/ws-multimodal");
      createSession("sess-ws", project.id, { agentRuntimeType: "pi" });
      const imageData = Buffer.from("runtime image bytes");
      const attachment = storeSessionAttachment("sess-ws", {
        data: imageData,
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
      const stub = createRuntimeStub();
      state.sessions.set("sess-ws", { id: "sess-ws", runtime: stub.runtime, lastActivity: 0 });

      const sender = createMockWs();
      const observer = createMockWs();
      handleWsOpen(state, sender.ws);
      handleWsOpen(state, observer.ws);

      handleWsMessage(state, sender.ws, JSON.stringify({
        type: "prompt",
        sessionId: "sess-ws",
        message,
      }));

      await Bun.sleep(10);

      expect(sender.lastMessage()).toEqual({ type: "ack", command: "prompt" });
      expect(stub.promptCalls).toHaveLength(1);
      expect(stub.promptCalls[0]).toEqual(message);
      expect(observer.lastMessage()).toEqual({
        type: "user_message",
        sessionId: "sess-ws",
        projectId: project.id,
        message,
      });
      expect(JSON.stringify(observer.lastMessage())).not.toContain(imageData.toString("base64"));
    });
  });
});
