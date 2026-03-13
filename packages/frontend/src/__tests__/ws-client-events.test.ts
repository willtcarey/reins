/**
 * Tests for WS client event listener contract.
 *
 * Verifies that EventListener receives (sessionId, projectId, event)
 * in the correct argument positions for all message types.
 */

import { describe, it, expect } from "bun:test";
import { AppClient } from "../ws-client.js";

/**
 * Create an AppClient and invoke its private handleMessage method
 * to simulate an inbound WS message without needing a real WebSocket.
 */
function simulateMessage(msg: any): { sessionId: string; projectId: number; event: any }[] {
  const client = new AppClient("ws://localhost:0");
  const received: { sessionId: string; projectId: number; event: any }[] = [];

  client.onEvent((sessionId, projectId, event) => {
    received.push({ sessionId, projectId, event });
  });

  // Access private handleMessage
  (client as any).handleMessage(msg);

  return received;
}

describe("WS client EventListener contract", () => {
  it("passes (sessionId, projectId, event) for 'event' messages", () => {
    const received = simulateMessage({
      type: "event",
      sessionId: "sess-1",
      projectId: 42,
      event: { type: "agent_start" },
    });

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("sess-1");
    expect(received[0].projectId).toBe(42);
    expect(received[0].event).toEqual({ type: "agent_start" });
  });

  it("passes projectId for 'task_updated' messages", () => {
    const received = simulateMessage({
      type: "task_updated",
      projectId: 7,
    });

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("");
    expect(received[0].projectId).toBe(7);
    expect(received[0].event.type).toBe("task_updated");
  });

  it("passes projectId for 'session_created' messages", () => {
    const received = simulateMessage({
      type: "session_created",
      projectId: 5,
      sessionId: "new-sess",
      taskId: 3,
    });

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("");
    expect(received[0].projectId).toBe(5);
    expect(received[0].event.type).toBe("session_created");
    expect(received[0].event.sessionId).toBe("new-sess");
    expect(received[0].event.taskId).toBe(3);
  });

  it("passes (sessionId, projectId, event) for 'user_message' messages", () => {
    const received = simulateMessage({
      type: "user_message",
      sessionId: "sess-1",
      projectId: 42,
      message: "hello world",
    });

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("sess-1");
    expect(received[0].projectId).toBe(42);
    expect(received[0].event.type).toBe("user_message");
    expect(received[0].event.message).toBe("hello world");
  });

  it("event argument is always an object, never a number", () => {
    const received = simulateMessage({
      type: "event",
      sessionId: "sess-1",
      projectId: 99,
      event: { type: "agent_end" },
    });

    // This is the exact regression that broke chat streaming:
    // if event listener signature is wrong, event receives projectId (a number)
    expect(typeof received[0].event).toBe("object");
    expect(typeof received[0].event).not.toBe("number");
    expect(received[0].event.type).toBe("agent_end");
  });
});
