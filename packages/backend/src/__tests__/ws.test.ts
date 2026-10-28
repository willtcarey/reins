import { describe, test, expect } from "bun:test";
import { handleWsMessage } from "../ws.js";

/** A socket that keeps what is sent to it. */
function createMockWs() {
  const sent: string[] = [];
  return {
    ws: { send(data: string) { sent.push(data); return data.length; } },
    messages: () => sent.map((data) => JSON.parse(data)),
  };
}

describe("handleWsMessage", () => {
  test("answers a ping with a pong", () => {
    const socket = createMockWs();
    handleWsMessage(socket.ws, JSON.stringify({ type: "ping" }));
    expect(socket.messages()).toEqual([{ type: "pong" }]);
  });

  test("answers a message that is not JSON, as a string or a buffer, with an error", () => {
    const socket = createMockWs();
    handleWsMessage(socket.ws, "not valid json{{{");
    handleWsMessage(socket.ws, Buffer.from("not json"));
    expect(socket.messages()).toEqual([{ type: "error", error: "Invalid JSON" }, { type: "error", error: "Invalid JSON" }]);
  });

  test("answers any other command, session operations included (they are HTTP routes), with an error", () => {
    const socket = createMockWs();
    handleWsMessage(socket.ws, JSON.stringify({ type: "prompt", sessionId: "s", clientId: "c", message: [{ type: "text", text: "hi" }] }));
    expect(socket.messages()).toEqual([{ type: "error", error: "Unknown command: prompt" }]);
  });
});
