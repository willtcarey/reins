import { describe, expect, test, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { attachRuntimeBroadcastObserver } from "../../runtimes/runtime-broadcast-observer.js";
import type { AgentRuntime, AgentRuntimeEvent } from "../../runtimes/registry.js";

function createRuntimeStub() {
  let listener: ((event: AgentRuntimeEvent) => void) | null = null;
  const runtime: AgentRuntime = {
    prompt: async () => {},
    steer: async () => {},
    abort: async () => {},
    setModel: async () => {},
    subscribe: (candidate) => {
      listener = candidate;
      return () => { listener = null; };
    },
    getMessages: async () => [],
    isStreaming: () => false,
    close: async () => {},
  };

  return {
    runtime,
    emit(event: AgentRuntimeEvent) {
      if (!listener) throw new Error("Runtime listener was not attached");
      listener(event);
    },
  };
}

function createWsClient() {
  const sent: string[] = [];
  return {
    client: {
      ws: {
        send: mock((data: string) => {
          sent.push(data);
          return data.length;
        }),
      },
    },
    lastMessage(): any {
      return JSON.parse(sent[sent.length - 1] ?? "null");
    },
  };
}

describe("runtime broadcast observer", () => {
  useTestDb();

  let projectId: number;

  beforeEach(() => {
    const project = createProject("Runtime Broadcast Project", "/tmp/runtime-broadcast-project");
    projectId = project.id;
    createSession("sess-runtime-broadcast", projectId, { agentRuntimeType: "pi" });
  });

  test("externalizes inline images in known runtime event content fields", () => {
    const { runtime, emit } = createRuntimeStub();
    const ws = createWsClient();
    const clients = new Set([ws.client]);
    const imageData = Buffer.from("broadcast image").toString("base64");

    attachRuntimeBroadcastObserver({
      sessionId: "sess-runtime-broadcast",
      projectId,
      runtime,
      clients,
    });

    emit({
      type: "tool_execution_end",
      toolCallId: "tc-read",
      toolName: "read",
      isError: false,
      result: {
        content: [
          { type: "text", text: "image result" },
          { type: "image", data: imageData, mimeType: "image/png", filename: "result.png" },
        ],
        details: { path: "result.png" },
      },
    });

    const payload = ws.lastMessage();
    expect(payload.type).toBe("event");
    expect(payload.event.result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      filename: "result.png",
      byteSize: Buffer.from("broadcast image").length,
    });
    expect(payload.event.result.content[1].attachmentId).toStartWith("att_");
    expect(payload.event.result.content[1].data).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(imageData);
  });
});
