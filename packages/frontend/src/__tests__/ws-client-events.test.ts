import { describe, expect, it } from "bun:test";
import { AppClient, type InboundMessage } from "../models/ws-client.js";

describe("AppClient outbound submission replay", () => {
  it("tracks and acknowledges prompt and steer submissions independently", () => {
    const client = new AppClient("ws://localhost:0");
    client.prompt("sess-1", [{ type: "text", text: "first" }], "submission-1");
    client.steer("sess-1", [{ type: "text", text: "second" }], "submission-2");

    expect([...client["pendingOutboundMessages"].keys()]).toEqual(["submission-1", "submission-2"]);

    client["handleMessage"]({ type: "ack", command: "prompt", clientId: "submission-1" });

    expect([...client["pendingOutboundMessages"].keys()]).toEqual(["submission-2"]);

    client.prompt("sess-1", [{ type: "text", text: "third" }], "submission-3");
    client["handleMessage"]({ type: "error", sessionId: "sess-1", clientId: "submission-2", error: "rejected" });
    expect([...client["pendingOutboundMessages"].keys()]).toEqual(["submission-3"]);
  });
});

describe("AppClient inbound event source", () => {
  it("delivers the complete typed runtime envelope", () => {
    const client = new AppClient("ws://localhost:0");
    const received: InboundMessage[] = [];
    const message = {
      type: "event" as const,
      sessionId: "sess-1",
      projectId: 42,
      seq: 1, emittedAt: 0,
      event: {
        type: "message_update" as const,
        streamId: "stream-1",
        assistantMessageEvent: { type: "text_delta" as const, contentIndex: 0, delta: "partial" },
      },
    };
    client.subscribe({ event: (inbound) => received.push(inbound) });

    client["handleMessage"](message);

    expect(received).toEqual([message]);
  });

  it("preserves each message's natural scope without synthetic identifiers", () => {
    const client = new AppClient("ws://localhost:0");
    const received: InboundMessage[] = [];
    const taskUpdate = { type: "task_updated" as const, projectId: 7 };
    const error = { type: "error" as const, error: "Invalid JSON" };
    client.subscribe({
      task_updated: (message) => received.push(message),
      error: (message) => received.push(message),
    });

    client["handleMessage"](taskUpdate);
    client["handleMessage"](error);

    expect(received).toEqual([taskUpdate, error]);
  });

  it("delivers only subscribed message kinds", () => {
    const client = new AppClient("ws://localhost:0");
    const received: InboundMessage[] = [];
    client.subscribe({
      task_updated: (message) => received.push(message),
      session_updated: (message) => received.push(message),
    });

    client["handleMessage"]({ type: "task_updated", projectId: 7 });
    client["handleMessage"]({ type: "open_file", sessionId: "sess-1", projectId: 7, path: "a.ts" });
    client["handleMessage"]({ type: "session_updated", sessionId: "sess-1", projectId: 7 });

    expect(received).toEqual([
      { type: "task_updated", projectId: 7 },
      { type: "session_updated", sessionId: "sess-1", projectId: 7 },
    ]);
  });
});
