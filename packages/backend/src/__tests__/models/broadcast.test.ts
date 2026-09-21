/**
 * Tests for the broadcast abstraction.
 *
 * Contracts:
 *  - broadcast sends a message to all connected clients
 */
import { describe, test, expect } from "bun:test";
import { createBroadcast } from "../../models/broadcast.js";
import type { WsClient } from "../../state.js";

function createMockClient(): { client: WsClient; sent: string[] } {
  const sent: string[] = [];
  const client: WsClient = {
    ws: { send(data: string) { sent.push(data); return data.length; } },
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