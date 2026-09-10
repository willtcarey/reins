import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSdkAgentRuntime } from "../../../runtimes/claude_agent_sdk/runtime.js";
import { createProject } from "../../../project-store.js";
import { createSession } from "../../../session-store.js";
import { storeSessionAttachment } from "../../../session-attachments-store.js";
import { useTestDb } from "../../helpers/test-db.js";

// Stub only the subprocess boundary; exercise the real runtime and SDK event mapping.
function controlledSdk() {
  let input: AsyncIterator<SDKUserMessage>;
  let output: ReadableStreamDefaultController<SDKMessage>;
  const finish = (error?: string) => {
    output.enqueue({
      type: "result", subtype: "success", stop_reason: "end_turn", is_error: !!error,
      duration_ms: 0, duration_api_ms: 0, num_turns: 1, result: error ?? "done", total_cost_usd: 0,
      modelUsage: {}, permission_denials: [], uuid: crypto.randomUUID(), session_id: "test",
      usage: {
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard",
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: "", iterations: [], speed: "standard",
      },
    });
  };
  const start: NonNullable<ConstructorParameters<typeof ClaudeSdkAgentRuntime>[1]> = ({ prompt }) => {
    if (typeof prompt === "string") throw new Error("Expected streaming input");
    input = prompt[Symbol.asyncIterator]();
    const stream = new ReadableStream<SDKMessage>({ start(controller) { output = controller; } });
    return {
      async *[Symbol.asyncIterator]() {
        const reader = stream.getReader();
        for (;;) {
          const item = await reader.read();
          if (item.done) return;
          yield item.value;
        }
      },
      interrupt: async () => { finish(); },
      setModel: async () => {},
      close: () => { output.close(); },
    };
  };
  return {
    query: start,
    input: async () => (await input.next()).value,
    finish,
    fail: (error: Error) => { output.error(error); },
  };
}

describe("ClaudeSdkAgentRuntime", () => {
  useTestDb();

  test("starts idle work, rejects busy delivery, and accepts another message after settlement", async () => {
    const sdk = controlledSdk();
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "steering-session", projectDir: "/tmp", systemPrompt: "Help", resumeOnFirstPrompt: false, customTools: [],
    }, sdk.query);
    const first = runtime.prompt([{ type: "text", text: "one" }]);
    let settled = false;
    const waiting = runtime.waitForIdle().then(() => { settled = true; });
    expect(await sdk.input()).toMatchObject({ message: { content: [{ type: "text", text: "one" }] } });
    expect(runtime.isStreaming()).toBe(true);
    expect(settled).toBe(false);
    await expect(runtime.steer([{ type: "text", text: "adjust" }])).rejects.toThrow("Steering is not supported");
    sdk.finish();
    await first;
    await waiting;
    expect(runtime.isStreaming()).toBe(false);
    const second = runtime.prompt([{ type: "text", text: "two" }]);
    expect(await sdk.input()).toMatchObject({ message: { content: [{ type: "text", text: "two" }] } });
    sdk.finish();
    await second;
    await runtime.waitForIdle();
    await runtime.close();
  });

  test("error results fail waits", async () => {
    const sdk = controlledSdk();
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "error-result", projectDir: "/tmp", systemPrompt: "Help", resumeOnFirstPrompt: false, customTools: [],
    }, sdk.query);
    const completion = runtime.prompt([{ type: "text", text: "one" }]);
    void completion.catch(() => {});
    await sdk.input();
    sdk.finish("Turn failed");
    await expect(completion).rejects.toThrow("Turn failed");
    await expect(runtime.waitForIdle()).rejects.toThrow("Turn failed");
    expect(runtime.isStreaming()).toBe(false);
    await runtime.close();
  });

  test("wait reports SDK failure and cancellation", async () => {
    const sdk = controlledSdk();
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "failed-session", projectDir: "/tmp", systemPrompt: "Help", resumeOnFirstPrompt: false, customTools: [],
    }, sdk.query);
    const completion = runtime.prompt([{ type: "text", text: "one" }]);
    void completion.catch(() => {});
    await sdk.input();
    sdk.fail(new Error("SDK failed"));
    await expect(completion).rejects.toThrow("SDK failed");
    await expect(runtime.waitForIdle()).rejects.toThrow("SDK failed");
    const retry = runtime.prompt([{ type: "text", text: "retry" }]);
    await sdk.input();
    await runtime.abort();
    await retry;
    await expect(runtime.waitForIdle()).rejects.toThrow("Aborted");
    expect(runtime.isStreaming()).toBe(false);
    await runtime.close();
  });

  test("rejects steer with a clear unsupported message", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    await expect(runtime.steer([{ type: "text", text: "course-correct" }])).rejects.toThrow(
      "Steering is not supported on Claude runtime yet. Wait for completion or abort and send a new prompt.",
    );
  });

  test("prompt while streaming instructs caller to wait or abort", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    Reflect.set(runtime, "queryHandle", {});
    Reflect.set(runtime, "activePromptId", 42);

    await expect(runtime.prompt([{ type: "text", text: "new prompt" }])).rejects.toThrow(
      "Prompt already running. Wait for completion or abort and send a new prompt.",
    );
  });

  test("follow-up prompt enqueues into the long-lived input stream", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    const enqueued: unknown[] = [];

    Reflect.set(runtime, "queryHandle", {});
    Reflect.set(runtime, "inputStream", {
      enqueue: (message: unknown) => {
        enqueued.push(message);
      },
      close: () => {},
    });

    const promptPromise = runtime.prompt([{ type: "text", text: "follow-up" }]);

    const resolvePrompt = Reflect.get(runtime, "resolvePrompt");
    if (typeof resolvePrompt !== "function") throw new Error("resolvePrompt is unavailable");
    Reflect.apply(resolvePrompt, runtime, [1]);

    await expect(promptPromise).resolves.toBeUndefined();
    expect(enqueued).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "follow-up" }],
        },
        parent_tool_use_id: null,
      },
    ]);

    await runtime.close();
  });

  test("prompt hydrates attachment refs before enqueueing SDK user content", async () => {
    const project = createProject("Claude Runtime Images", "/tmp/claude-runtime-images");
    createSession("session-with-image", project.id, { agentRuntimeType: "claude_agent_sdk" });
    const imageData = Buffer.from("claude prompt image");
    const attachment = storeSessionAttachment("session-with-image", {
      data: imageData,
      mimeType: "image/png",
      filename: "prompt.png",
    });
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-with-image",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    const enqueued: unknown[] = [];
    Reflect.set(runtime, "queryHandle", {});
    Reflect.set(runtime, "inputStream", {
      enqueue: (message: unknown) => {
        enqueued.push(message);
      },
      close: () => {},
    });

    const promptPromise = runtime.prompt([
      { type: "text", text: "describe" },
      {
        type: "image",
        attachmentId: attachment.id,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        byteSize: attachment.byteSize,
        sha256: attachment.sha256,
      },
    ]);

    const resolvePrompt = Reflect.get(runtime, "resolvePrompt");
    if (typeof resolvePrompt !== "function") throw new Error("resolvePrompt is unavailable");
    Reflect.apply(resolvePrompt, runtime, [1]);

    await expect(promptPromise).resolves.toBeUndefined();
    expect(enqueued).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageData.toString("base64"),
              },
            },
          ],
        },
        parent_tool_use_id: null,
      },
    ]);

    await runtime.close();
  });

  test("isStreaming becomes true immediately after prompt is enqueued", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    Reflect.set(runtime, "queryHandle", {});
    Reflect.set(runtime, "inputStream", {
      enqueue: () => {},
      close: () => {},
    });

    expect(runtime.isStreaming()).toBe(false);

    const promptPromise = runtime.prompt([{ type: "text", text: "hello" }]);

    // isStreaming should be true immediately, before SDK events arrive
    expect(runtime.isStreaming()).toBe(true);

    const resolvePrompt = Reflect.get(runtime, "resolvePrompt");
    if (typeof resolvePrompt !== "function") throw new Error("resolvePrompt is unavailable");
    Reflect.apply(resolvePrompt, runtime, [1]);

    await promptPromise;
    await runtime.close();
  });

  test("prompt emits agent_start immediately to subscribers", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    Reflect.set(runtime, "queryHandle", {});
    Reflect.set(runtime, "inputStream", {
      enqueue: () => {},
      close: () => {},
    });

    const events: { type: string }[] = [];
    runtime.subscribe((event) => events.push({ type: event.type }));

    const promptPromise = runtime.prompt([{ type: "text", text: "hello" }]);

    expect(events).toEqual([{ type: "agent_start" }]);

    const resolvePrompt = Reflect.get(runtime, "resolvePrompt");
    if (typeof resolvePrompt !== "function") throw new Error("resolvePrompt is unavailable");
    Reflect.apply(resolvePrompt, runtime, [1]);

    await promptPromise;
    await runtime.close();
  });

  test("failOutstandingPrompts emits agent_end with a structured error message when streaming was active", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    Reflect.set(runtime, "queryHandle", {});
    Reflect.set(runtime, "inputStream", {
      enqueue: () => {},
      close: () => {},
    });

    const events: Array<{ type: string; messages?: unknown[] }> = [];
    runtime.subscribe((event) => {
      if (event.type === "agent_end") {
        events.push({ type: event.type, messages: [...event.messages] });
        return;
      }
      events.push({ type: event.type });
    });

    // Simulate a prompt that signals streaming start
    const promptPromise = runtime.prompt([{ type: "text", text: "hello" }]);
    expect(runtime.isStreaming()).toBe(true);
    expect(events).toEqual([{ type: "agent_start" }]);

    // Simulate the SDK stream failing
    const failOutstandingPrompts = Reflect.get(runtime, "failOutstandingPrompts");
    if (typeof failOutstandingPrompts !== "function") throw new Error("failOutstandingPrompts is unavailable");
    Reflect.apply(failOutstandingPrompts, runtime, [new Error("subprocess crashed")]);

    expect(runtime.isStreaming()).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "agent_start" });
    expect(events[1]?.type).toBe("agent_end");
    expect(events[1]?.messages).toEqual([
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "subprocess crashed",
        timestamp: expect.any(Number),
      },
    ]);

    await expect(promptPromise).rejects.toThrow("subprocess crashed");
    await runtime.close();
  });

  test("failOutstandingPrompts does not emit agent_end when not streaming", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    const events: { type: string }[] = [];
    runtime.subscribe((event) => events.push({ type: event.type }));

    expect(runtime.isStreaming()).toBe(false);

    const failOutstandingPrompts = Reflect.get(runtime, "failOutstandingPrompts");
    if (typeof failOutstandingPrompts !== "function") throw new Error("failOutstandingPrompts is unavailable");
    Reflect.apply(failOutstandingPrompts, runtime, [new Error("something broke")]);

    expect(runtime.isStreaming()).toBe(false);
    expect(events).toEqual([]);

    await runtime.close();
  });

  test("abort aborts the current run tool signal and the next prompt gets a fresh signal", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    const interruptCalls: number[] = [];
    Reflect.set(runtime, "queryHandle", {
      interrupt: async () => {
        interruptCalls.push(Date.now());
      },
    });
    Reflect.set(runtime, "inputStream", {
      enqueue: () => {},
      close: () => {},
    });

    const firstPrompt = runtime.prompt([{ type: "text", text: "first" }]);
    const firstController = Reflect.get(runtime, "currentToolAbortController");
    expect(firstController).toBeInstanceOf(AbortController);
    expect(firstController.signal.aborted).toBe(false);

    await runtime.abort();

    expect(interruptCalls).toHaveLength(1);
    expect(firstController.signal.aborted).toBe(true);

    const resolvePrompt = Reflect.get(runtime, "resolvePrompt");
    if (typeof resolvePrompt !== "function") throw new Error("resolvePrompt is unavailable");
    Reflect.apply(resolvePrompt, runtime, [1]);
    await firstPrompt;
    Reflect.set(runtime, "activePromptId", null);

    const secondPrompt = runtime.prompt([{ type: "text", text: "second" }]);
    const secondController = Reflect.get(runtime, "currentToolAbortController");
    expect(secondController).toBeInstanceOf(AbortController);
    expect(secondController).not.toBe(firstController);
    expect(secondController.signal.aborted).toBe(false);

    Reflect.apply(resolvePrompt, runtime, [2]);
    await secondPrompt;
    await runtime.close();
  });

  test("query options include sessionStore backed by our database", () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp/my-project",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    const buildQueryOptions = Reflect.get(runtime, "buildQueryOptions");
    if (typeof buildQueryOptions !== "function") throw new Error("buildQueryOptions is unavailable");
    const options: Record<string, unknown> = Reflect.apply(buildQueryOptions, runtime, [null]);

    expect(options.sessionStore).toBeDefined();
    const store = options.sessionStore;
    expect(store).toHaveProperty("load");
    expect(store).toHaveProperty("append");
    expect(store).toHaveProperty("listSubkeys");
  });

  test("input stream errors do not trigger unhandled rejections", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    Reflect.set(runtime, "queryHandle", {});
    Reflect.set(runtime, "inputStream", {
      enqueue: () => {
        throw new Error("ProcessTransport is not ready for writing");
      },
      close: () => {},
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };

    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(runtime.prompt([{ type: "text", text: "follow-up" }])).rejects.toThrow("ProcessTransport is not ready for writing");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await runtime.close();
    }
  });
});
