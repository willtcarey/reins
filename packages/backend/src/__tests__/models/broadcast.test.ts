/**
 * Tests for the broadcast abstraction.
 *
 * Contracts:
 *  - broadcast sends a message to all connected clients
 *  - broadcastExcluding sends to all clients except the excluded one
 */
import { describe, test, expect } from "bun:test";
import { createBroadcast, createBroadcastExcluding } from "../../models/broadcast.js";
import type { WsClient } from "../../state.js";

function createMockClient(): { client: WsClient; sent: string[] } {
  const sent: string[] = [];
  const client: WsClient = {
    ws: { send(data: string) { sent.push(data); } },
  };
  return { client, sent };
}

describe("createBroadcast", () => {
  test("sends message to all clients", () => {
    const a = createMockClient();
    const b = createMockClient();
    const clients = new Set([a.client, b.client]);

    const broadcast = createBroadcast(clients);
    broadcast({ type: "task_updated", projectId: 1 });

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0])).toEqual({ type: "task_updated", projectId: 1 });
  });
});

describe("createBroadcastExcluding", () => {
  test("sends to all clients except the excluded one", () => {
    const sender = createMockClient();
    const other = createMockClient();
    const clients = new Set([sender.client, other.client]);

    const broadcast = createBroadcastExcluding(clients, sender.client);
    broadcast({ type: "user_message", sessionId: "s1", projectId: 1, message: "hello" });

    expect(sender.sent).toHaveLength(0);
    expect(other.sent).toHaveLength(1);
    expect(JSON.parse(other.sent[0])).toEqual({
      type: "user_message",
      sessionId: "s1",
      projectId: 1,
      message: "hello",
    });
  });

  test("sends to all when excluded client is not in the set", () => {
    const a = createMockClient();
    const b = createMockClient();
    const outsider = createMockClient();
    const clients = new Set([a.client, b.client]);

    const broadcast = createBroadcastExcluding(clients, outsider.client);
    broadcast({ type: "task_updated", projectId: 1 });

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });
});
