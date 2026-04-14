import { describe, expect, test } from "bun:test";
import { ClaudeSdkAgentRuntime } from "../../../runtimes/claude_agent_sdk/runtime.js";

describe("ClaudeSdkAgentRuntime", () => {
  test("rejects steer with a clear unsupported message", async () => {
    const runtime = new ClaudeSdkAgentRuntime({
      sessionId: "session-1",
      projectDir: "/tmp",
      systemPrompt: "You are helpful",
      resumeOnFirstPrompt: false,
      customTools: [],
    });

    await expect(runtime.steer("course-correct")).rejects.toThrow(
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

    await expect(runtime.prompt("new prompt")).rejects.toThrow(
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

    const promptPromise = runtime.prompt("follow-up");

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

    const promptPromise = runtime.prompt("hello");

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

    const promptPromise = runtime.prompt("hello");

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
        events.push({ type: event.type, messages: event.messages as unknown[] | undefined });
        return;
      }
      events.push({ type: event.type });
    });

    // Simulate a prompt that signals streaming start
    const promptPromise = runtime.prompt("hello");
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

    const firstPrompt = runtime.prompt("first");
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

    const secondPrompt = runtime.prompt("second");
    const secondController = Reflect.get(runtime, "currentToolAbortController");
    expect(secondController).toBeInstanceOf(AbortController);
    expect(secondController).not.toBe(firstController);
    expect(secondController.signal.aborted).toBe(false);

    Reflect.apply(resolvePrompt, runtime, [2]);
    await secondPrompt;
    await runtime.close();
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
      await expect(runtime.prompt("follow-up")).rejects.toThrow("ProcessTransport is not ready for writing");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await runtime.close();
    }
  });
});
