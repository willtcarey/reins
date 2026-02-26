import { describe, test, expect, beforeEach } from "bun:test";
import { handleWsOpen, handleWsMessage, handleWsClose } from "../ws.js";
import { createTestState } from "./helpers/test-state.js";
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
    state = createTestState();
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
      handleWsMessage(state, mock.ws, buf as any);

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
  });
});
