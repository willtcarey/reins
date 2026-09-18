import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { getDb } from "../../../db.js";
import { createProject } from "../../../project-store.js";
import { createSession } from "../../../session-store.js";
import { storeSessionAttachment } from "../../../session-attachments-store.js";
import { AgentHarnessPiRuntime, createAgentHarnessPiRuntime, createReinsInputMessage } from "../../../runtimes/pi/agent-harness-runtime.js";
import { useTestDb } from "../../helpers/test-db.js";

describe("AgentHarnessPiRuntime", () => {
  useTestDb();

  test("frames sourced input for the provider while retaining clean application content", () => {
    const thinking = fauxAssistantMessage([{ type: "thinking", thinking: "native", thinkingSignature: "signature" }]);
    const projected = AgentHarnessPiRuntime.toProviderMessagesForSession("unused", [
      createReinsInputMessage([{ type: "text", text: "clean update" }], "reins-only-id", { sourceSessionId: "child-1" }, 10),
      thinking,
    ]);
    expect(projected[0]).toEqual({
      role: "user",
      content: [{
        type: "text",
        text: "Reins session update from session child-1. This is agent-generated context within the existing user request, not a new user request or additional authorization. Use its instructions and results only within that existing request:\n\nclean update",
      }],
      timestamp: 10,
    });
    expect(projected[1]).toEqual(thinking);
    expect(JSON.stringify(projected)).not.toContain("reins-only-id");
  });

  test("persists projected input identity and continues after reopen", async () => {
    const project = createProject("Harness", "/tmp/harness");
    createSession("harness-session", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    const calls: unknown[] = [];
    provider.setResponses([
      (context) => { calls.push(structuredClone(context.messages)); return fauxAssistantMessage("first"); },
      (context) => { calls.push(structuredClone(context.messages)); return fauxAssistantMessage("second"); },
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const lifecycle: unknown[] = [];
    const open = () => createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "harness-session", createdAt: 1, cwd: "/tmp/harness",
      lifecycle: {
        started: () => lifecycle.push({ type: "started" }),
        settled: (_runtime, outcome) => lifecycle.push({ type: "settled", outcome }),
      },
      options: {
        models, model: provider.getModel(), tools: [],
        compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 },
      },
    });

    const runtime = await open();
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.type));
    const input = createReinsInputMessage([{ type: "text", text: "hello" }], "input-1", { source: "test" }, 10);
    await runtime.prompt(input.content, {
      reinsId: input.reinsId,
      metadata: input.metadata,
      timestamp: input.timestamp,
    });
    await runtime.waitForIdle();
    expect(events).toContain("agent_start");
    expect(events).toContain("message_update");
    expect(events.at(-1)).toBe("agent_end");
    expect(lifecycle).toEqual([
      { type: "started" },
      { type: "settled", outcome: { runId: expect.any(String), status: "completed" } },
    ]);
    expect(await runtime.getMessages()).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: { source: "test" },
        timestamp: 10,
        logicalId: expect.any(String),
      },
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "first" }], logicalId: expect.any(String) }),
    ]);
    const stored = getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE role = 'reinsInput'").get();
    expect(JSON.parse(stored!.message_json).message).toEqual(input);
    await runtime.close();

    const reopenedRuntime = await open();
    expect(await reopenedRuntime.getLastRunOutcome()).toMatchObject({
      runId: expect.any(String), status: "completed",
    });
    expect(calls).toHaveLength(1);
    const secondRunMessages: unknown[][] = [];
    reopenedRuntime.subscribe((event) => {
      if (event.type === "agent_end") secondRunMessages.push(event.messages);
    });
    await expect(reopenedRuntime.setModel({ provider: "missing", modelId: "missing" }))
      .rejects.toThrow("Model not found: missing/missing");
    expect(reopenedRuntime.getSessionMetadata()).toEqual({
      model: { provider: provider.provider.id, modelId: "fake" },
      thinkingLevel: "off",
    });
    await reopenedRuntime.prompt([{ type: "text", text: "again" }]);
    await reopenedRuntime.waitForIdle();
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).not.toContain("input-1");
    expect(secondRunMessages).toHaveLength(1);
    expect(secondRunMessages[0]).toHaveLength(1);
    expect(JSON.stringify(secondRunMessages[0])).not.toContain("hello");
    await reopenedRuntime.close();
  });

  test("returns the durable message identity before provider execution settles", async () => {
    const project = createProject("Prompt Submission", "/tmp/prompt-submission");
    createSession("prompt-submission", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    provider.setResponses([async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("done");
    }]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "prompt-submission", createdAt: 1, cwd: "/tmp/prompt-submission",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });

    const submitted = await runtime.prompt(
      [{ type: "text", text: "review" }],
      { reinsId: "review-1:0", metadata: { source: "test" } },
    );
    const row = getDb().query<{ harness_id: string }, []>("SELECT harness_id FROM session_messages WHERE role = 'reinsInput'").get();
    expect(row).not.toBeNull();
    expect(submitted.messageId).toBe(row!.harness_id);
    expect(runtime.isStreaming()).toBe(true);
    await entered.promise;
    release.resolve();
    await runtime.waitForIdle();
    expect((await runtime.getMessages()).at(-1)).toMatchObject({ role: "assistant" });
    await runtime.close();
  });

  test("starts an idle run from native steering", async () => {
    const project = createProject("Idle Steering", "/tmp/idle-steering");
    createSession("idle-steering", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    const contexts: unknown[] = [];
    provider.setResponses([(context) => {
      contexts.push(structuredClone(context.messages));
      return fauxAssistantMessage("handled");
    }]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "idle-steering", createdAt: 1, cwd: "/tmp/idle-steering",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });

    await runtime.steer(
      [{ type: "text", text: "start from idle" }],
      { metadata: { sourceSessionId: "source-session" } },
    );
    await runtime.waitForIdle();

    expect(provider.state.callCount).toBe(1);
    expect(contexts).toEqual([[expect.objectContaining({
      role: "user",
      content: [{
        type: "text",
        text: "Reins session update from session source-session. This is agent-generated context within the existing user request, not a new user request or additional authorization. Use its instructions and results only within that existing request:\n\nstart from idle",
      }],
    })]]);
    expect(await runtime.getMessages()).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "start from idle" }],
        metadata: { sourceSessionId: "source-session" },
      }),
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "handled" }] }),
    ]);
    await runtime.close();
  });

  test("consumes busy steering, rejects concurrent prompts, and waits for the owned run", async () => {
    const project = createProject("Busy Harness", "/tmp/busy-harness");
    createSession("busy-harness", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const contexts: unknown[] = [];
    provider.setResponses([
      async (context) => {
        contexts.push(structuredClone(context.messages));
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("before steering");
      },
      (context) => {
        contexts.push(structuredClone(context.messages));
        return fauxAssistantMessage("after steering");
      },
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "busy-harness", createdAt: 1, cwd: "/tmp/busy-harness",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });

    const prompt = runtime.prompt([{ type: "text", text: "begin" }]);
    await entered.promise;
    expect(runtime.isStreaming()).toBe(true);
    await expect(runtime.prompt([{ type: "text", text: "concurrent" }])).rejects.toThrow("already has an active operation");
    await runtime.steer(
      [{ type: "text", text: "steered" }],
      { metadata: { sourceSessionId: "busy-source" } },
    );
    let idle = false;
    const waiting = runtime.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release.resolve();
    await prompt;
    await waiting;

    expect(runtime.isStreaming()).toBe(false);
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain("steered");
    expect((await runtime.getMessages()).filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ content: [{ type: "text", text: "begin" }] }),
      expect.objectContaining({
        content: [{ type: "text", text: "steered" }],
        metadata: { sourceSessionId: "busy-source" },
      }),
    ]);
    await runtime.close();
  });

  test("retries generation without duplicating the admitted input", async () => {
    const project = createProject("Retry Harness", "/tmp/retry-harness");
    createSession("retry-harness", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 unavailable" }),
      fauxAssistantMessage("recovered"),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "retry-harness", createdAt: 1, cwd: "/tmp/retry-harness",
      options: {
        models, model: provider.getModel(), tools: [],
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
        compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 },
      },
    });
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.type));

    await runtime.prompt([{ type: "text", text: "retry" }], {
      reinsId: "retry-input",
      metadata: { exact: true },
      timestamp: 5,
    });
    await runtime.waitForIdle();

    expect(provider.state.callCount).toBe(2);
    expect(events).toContain("auto_retry_start");
    expect(events).toContain("auto_retry_end");
    const storedInputs = getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_messages WHERE role = 'reinsInput'").get();
    expect(storedInputs?.count).toBe(1);
    await runtime.close();
  });

  test("preserves failed native run outcome details", async () => {
    const project = createProject("Failed Harness", "/tmp/failed-harness");
    createSession("failed-harness", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" })]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "failed-harness", createdAt: 1, cwd: "/tmp/failed-harness",
      options: {
        models, model: provider.getModel(), tools: [],
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 },
      },
    });
    let completion: unknown;
    runtime.subscribe((event) => { if (event.type === "agent_end") completion = event; });

    await runtime.prompt([{ type: "text", text: "fail" }]);
    await runtime.waitForIdle();

    expect(completion).toMatchObject({
      type: "agent_end",
      runId: expect.any(String),
      status: "failed",
      error: { message: "provider exploded" },
    });
    expect(await runtime.getLastRunOutcome()).toMatchObject({
      runId: expect.any(String), status: "failed", error: { message: "provider exploded" },
    });
    await runtime.close();
  });

  test("drives deferred suspension through durable completion", async () => {
    const project = createProject("Deferred Harness", "/tmp/deferred-harness");
    createSession("deferred-harness", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({
      models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }],
      deferred: { pendingFetches: 1, pollAfterMs: 0 },
    });
    provider.setResponses([fauxAssistantMessage("finished after deferred")]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "deferred-harness", createdAt: 1, cwd: "/tmp/deferred-harness",
      options: {
        models, model: provider.getModel(), tools: [],
        streamOptions: { deferred: true },
        compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 },
      },
    });
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.type));

    await runtime.prompt([{ type: "text", text: "defer" }]);
    await runtime.waitForIdle();

    expect(provider.state.callCount).toBe(1);
    expect(provider.state.deferredFetchCount).toBe(2);
    expect(events.at(-1)).toBe("agent_end");
    expect((await runtime.getMessages()).filter((message) => message.role === "user")).toHaveLength(1);
    await runtime.close();
  });

  test("ends only after automatic compaction and keeps run-local agent output", async () => {
    const project = createProject("Compact Harness", "/tmp/compact-harness");
    createSession("compact-harness", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 100, maxTokens: 20 }] });
    provider.setResponses([fauxAssistantMessage("compact this response")]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "compact-harness", createdAt: 1, cwd: "/tmp/compact-harness",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: true, reserveTokens: 99, keepRecentTokens: 1 } },
    });
    runtime.harness.hooks.on("before_compaction", ({ preparation }) => ({
      compaction: { summary: "compact summary", tokensBefore: preparation.tokensBefore, retainedTail: preparation.retainedTail },
    }));
    const events: { type: string; messages?: unknown[]; runId?: string; status?: string; error?: unknown }[] = [];
    let streamingAtRunEnd: boolean | undefined;
    runtime.subscribe((event) => {
      events.push(event);
      if (event.type === "agent_end") streamingAtRunEnd = runtime.isStreaming();
    });

    await runtime.prompt([{ type: "text", text: "a long enough prompt to compact" }]);
    await runtime.waitForIdle();

    const types = events.map((event) => event.type);
    expect(types).toContain("compaction_start");
    expect(types.indexOf("compaction_end")).toBeLessThan(types.indexOf("agent_end"));
    expect(types.at(-1)).toBe("agent_end");
    expect(streamingAtRunEnd).toBe(true);
    expect(events.find((event) => event.type === "agent_end")).toMatchObject({
      messages: [expect.any(Object)],
      runId: expect.any(String),
      status: "completed",
    });
    expect(await runtime.getLastRunOutcome()).toMatchObject({ runId: expect.any(String), status: "completed" });
    expect((await runtime.getMessages())[0]).toMatchObject({ role: "compactionSummary", summary: "compact summary" });
    await runtime.close();
  });

  test("hydrates persisted attachment references only at the provider boundary", async () => {
    const project = createProject("Image Harness", "/tmp/image-harness");
    createSession("image-harness", project.id, { agentRuntimeType: "pi" });
    const attachment = storeSessionAttachment("image-harness", {
      data: Buffer.from("image bytes"), mimeType: "image/png", filename: "image.png",
    });
    let providerContext: unknown;
    const provider = fauxProvider({ models: [{ id: "fake", input: ["text", "image"], contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([(context) => { providerContext = structuredClone(context.messages); return fauxAssistantMessage("seen"); }]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "image-harness", createdAt: 1, cwd: "/tmp/image-harness",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });

    await runtime.prompt([
      { type: "text", text: "inspect" },
      { type: "image", attachmentId: attachment.id, mimeType: attachment.mimeType, filename: attachment.filename, byteSize: attachment.byteSize, sha256: attachment.sha256 },
    ]);
    await runtime.waitForIdle();

    expect(JSON.stringify(providerContext)).toContain(Buffer.from("image bytes").toString("base64"));
    expect(JSON.stringify(providerContext)).not.toContain(attachment.id);
    expect(JSON.stringify(await runtime.getMessages())).toContain(attachment.id);
    await runtime.close();
  });

  test("runs a native tool with progress and the harness cancellation context", async () => {
    const project = createProject("Tool Harness", "/tmp/tool-harness");
    createSession("tool-harness", project.id, { agentRuntimeType: "pi" });
    const signals: (AbortSignal | undefined)[] = [];
    const tool = {
      name: "write", label: "write", description: "write a value", parameters: Type.Object({ value: Type.String() }), replay: "never" as const,
      prepareArguments: (args: unknown) => ({
        value: typeof args === "object" && args !== null && "text" in args && typeof args.text === "string" ? args.text : "",
      }),
      async execute(_id: string, params: { value: string }, onUpdate: (result: { content: { type: "text"; text: string }[]; details: { phase: string } }) => void, _toolContext: undefined, _invocation: unknown, context: typeof BACKGROUND_CONTEXT) {
        signals.push(context.abortSignal);
        onUpdate({ content: [{ type: "text", text: "working" }], details: { phase: "working" } });
        return { content: [{ type: "text" as const, text: `wrote ${params.value}` }], details: { phase: "done" } };
      },
    };
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { text: "one" }, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "tool-harness", createdAt: 1, cwd: "/tmp/tool-harness",
      options: { models, model: provider.getModel(), tools: [tool], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    const updates: unknown[] = [];
    runtime.subscribe((event) => { if (event.type === "tool_execution_update") updates.push(event.partialResult); });

    await runtime.prompt([{ type: "text", text: "use write" }]);
    await runtime.waitForIdle();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(updates).toEqual([{ content: [{ type: "text", text: "working" }], details: { phase: "working" } }]);
    expect((await runtime.getMessages()).some((message) => message.role === "toolResult" && message.toolCallId === "call-1" && JSON.stringify(message.content).includes("wrote one"))).toBe(true);
    await runtime.close();
  });

  test("reopens an in-process effect_pending operation without repeating its side effect", async () => {
    const project = createProject("Effect Recovery", "/tmp/effect-recovery");
    createSession("effect-recovery", project.id, { agentRuntimeType: "pi" });
    let sideEffects = 0;
    const effectReached = Promise.withResolvers<void>();
    const originalTool = {
      name: "effect", label: "effect", description: "mutates once", parameters: Type.Object({}), replay: "never" as const,
      async execute() {
        sideEffects++;
        effectReached.resolve();
        await new Promise<void>(() => undefined);
        return { content: [{ type: "text" as const, text: "unreachable" }], details: undefined };
      },
    };
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}, { id: "effect-call" }), { stopReason: "toolUse" })]);
    const models = createModels();
    models.setProvider(provider.provider);
    const first = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "effect-recovery", createdAt: 1, cwd: "/tmp/effect-recovery",
      options: { models, model: provider.getModel(), tools: [originalTool], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    // Intentionally leave the original run blocked after its side effect to model an interrupted process.
    void first.prompt([{ type: "text", text: "perform effect" }]).catch(() => undefined);
    await effectReached.promise;
    expect(sideEffects).toBe(1);

    const replacementTool = {
      name: "effect", label: "effect", description: "must not replay", parameters: Type.Object({}), replay: "never" as const,
      async execute() {
        sideEffects++;
        throw new Error("duplicate side effect");
      },
    };
    provider.setResponses([fauxAssistantMessage("recovered without replay")]);
    const reopened = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "effect-recovery", createdAt: 1, cwd: "/tmp/effect-recovery",
      options: { models, model: provider.getModel(), tools: [replacementTool], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    await reopened.resumePendingOperation();
    await reopened.waitForIdle();

    expect(sideEffects).toBe(1);
    expect((await reopened.getMessages()).some((message) => message.role === "toolResult" && message.isError && JSON.stringify(message.content).includes("interrupted"))).toBe(true);
    await reopened.close();
  });

  test("a new prompt resumes a passively reopened operation instead of reporting the lane busy", async () => {
    const project = createProject("Prompt Recovery", "/tmp/prompt-recovery");
    createSession("prompt-recovery", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([fauxAssistantMessage("continued after recovery")]);
    const models = createModels();
    models.setProvider(provider.provider);
    const options = { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } };
    const original = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "prompt-recovery", createdAt: 1, cwd: "/tmp/prompt-recovery", options,
    });
    const accepted = await original.lane.accept(
      { kind: "prompt", prompt: createReinsInputMessage([{ type: "text", text: "original" }]) },
      BACKGROUND_CONTEXT,
    );
    if (!accepted.ok) throw accepted.error;

    const reopened = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "prompt-recovery", createdAt: 1, cwd: "/tmp/prompt-recovery", options,
    });
    expect(reopened.isStreaming()).toBe(false);

    const submission = await reopened.prompt([{ type: "text", text: "continue" }]);
    await reopened.waitForIdle();

    const messages = await reopened.getMessages();
    expect(messages.find((message) => message.role === "user" && JSON.stringify(message.content).includes("continue"))?.logicalId)
      .toBe(submission.messageId);
    expect(provider.state.callCount).toBe(1);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
    await reopened.close();
    await original.harness.close(BACKGROUND_CONTEXT);
  });

  test("wait and close include a submission blocked before execution tracking", async () => {
    const project = createProject("Admission Gate", "/tmp/admission-gate");
    createSession("admission-gate", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([fauxAssistantMessage("too late")]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "admission-gate", createdAt: 1, cwd: "/tmp/admission-gate",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    const nativeAccept = runtime.lane.accept.bind(runtime.lane);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    Object.defineProperty(runtime.lane, "accept", { value: async (...args: Parameters<typeof nativeAccept>) => {
      entered.resolve();
      await release.promise;
      return nativeAccept(...args);
    } });

    const prompt = runtime.prompt([{ type: "text", text: "gated" }]);
    await entered.promise;
    expect(runtime.isStreaming()).toBe(true);
    let waited = false;
    const waiting = runtime.waitForIdle().then(() => { waited = true; });
    const closing = runtime.close();
    await Promise.resolve();
    expect(waited).toBe(false);
    release.resolve();
    await prompt;
    await waiting;
    await closing;
    expect(runtime.isStreaming()).toBe(false);
  });

  test("wait includes steering while native admission is still pending", async () => {
    const project = createProject("Steering Gate", "/tmp/steering-gate");
    createSession("steering-gate", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([fauxAssistantMessage("handled")]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "steering-gate", createdAt: 1, cwd: "/tmp/steering-gate",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    const nativeSteer = runtime.lane.steer.bind(runtime.lane);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    Object.defineProperty(runtime.lane, "steer", { value: async (...args: Parameters<typeof nativeSteer>) => {
      entered.resolve();
      await release.promise;
      return nativeSteer(...args);
    } });

    const steering = runtime.steer([{ type: "text", text: "gated" }]);
    await entered.promise;
    let waited = false;
    const waiting = runtime.waitForIdle().then(() => { waited = true; });
    await Promise.resolve();
    expect(waited).toBe(false);
    expect(runtime.isStreaming()).toBe(true);

    release.resolve();
    await steering;
    await waiting;
    expect((await runtime.getMessages()).at(-1)).toMatchObject({ role: "assistant" });
    await runtime.close();
  });

  test("nonterminal drive rejection emits no terminal event or stale outcome", async () => {
    const project = createProject("Drive Failure", "/tmp/drive-failure");
    createSession("drive-failure", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "drive-failure", createdAt: 1, cwd: "/tmp/drive-failure",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    Object.defineProperty(runtime.lane, "drive", { value: async () => { throw new Error("injected nonterminal drive failure"); } });
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.type));

    await runtime.prompt([{ type: "text", text: "fail drive" }]);
    await Bun.sleep(0);

    expect(events).not.toContain("agent_end");
    expect(runtime.isStreaming()).toBe(false);
    expect((await runtime.getMessages()).filter((message) => message.role === "assistant")).toEqual([]);
    await runtime.harness.close(BACKGROUND_CONTEXT);
  });

  test("keeps reopened operations passive until explicit recovery", async () => {
    const project = createProject("Recovery Harness", "/tmp/recovery-harness");
    createSession("recovery-harness", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    const recoveryStarted = Promise.withResolvers<void>();
    const finishRecovery = Promise.withResolvers<void>();
    provider.setResponses([async () => {
      recoveryStarted.resolve();
      await finishRecovery.promise;
      return fauxAssistantMessage("recovered");
    }]);
    const models = createModels();
    models.setProvider(provider.provider);
    const options = { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } };
    const originalRuntime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "recovery-harness", createdAt: 1, cwd: "/tmp/recovery-harness", options,
    });
    const acceptResult = await originalRuntime.lane.accept({ kind: "prompt", prompt: createReinsInputMessage([{ type: "text", text: "recover me" }]) }, BACKGROUND_CONTEXT);
    if (!acceptResult.ok) throw acceptResult.error;

    const reopened = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "recovery-harness", createdAt: 1, cwd: "/tmp/recovery-harness", options,
    });
    expect(reopened.isStreaming()).toBe(false);
    expect(provider.state.callCount).toBe(0);
    let completions = 0;
    reopened.subscribe((event) => { if (event.type === "agent_end") completions++; });

    await reopened.resumePendingOperation();
    await recoveryStarted.promise;
    await expect(reopened.resumePendingOperation())
      .rejects.toThrow("has no pending inactive operation");
    await expect(reopened.prompt([{ type: "text", text: "competing" }]))
      .rejects.toThrow("already has an active operation");
    finishRecovery.resolve();
    await reopened.waitForIdle();

    expect(provider.state.callCount).toBe(1);
    expect(completions).toBe(1);
    expect((await reopened.getMessages()).at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "recovered" }] });
    await reopened.close();
    await originalRuntime.harness.close(BACKGROUND_CONTEXT);
  });

  test("cancels a blocked native tool through the harness context", async () => {
    const project = createProject("Cancel Tool Harness", "/tmp/cancel-tool-harness");
    createSession("cancel-tool-harness", project.id, { agentRuntimeType: "pi" });
    const executing = Promise.withResolvers<void>();
    let observedAbort = false;
    const tool = {
      name: "plugin_effect", label: "effect", description: "blocks", parameters: Type.Object({}), replay: "never" as const,
      async execute(_id: string, _params: unknown, _onUpdate: unknown, _toolContext: unknown, _invocation: unknown, context: typeof BACKGROUND_CONTEXT) {
        executing.resolve();
        await new Promise<void>((_resolve, reject) => context.abortSignal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(context.abortSignal?.reason);
        }, { once: true }));
        return { content: [{ type: "text" as const, text: "unreachable" }], details: undefined };
      },
    };
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([fauxAssistantMessage(fauxToolCall("plugin_effect", {}, { id: "blocked-call" }), { stopReason: "toolUse" })]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "cancel-tool-harness", createdAt: 1, cwd: "/tmp/cancel-tool-harness",
      options: { models, model: provider.getModel(), tools: [tool], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });

    await runtime.prompt([{ type: "text", text: "run effect" }]);
    await executing.promise;
    await runtime.abort();
    await runtime.waitForIdle();

    expect(observedAbort).toBe(true);
    expect(runtime.isStreaming()).toBe(false);
    await runtime.close();
  });

  test("closes the harness once even when abort cleanup fails", async () => {
    const project = createProject("Close Harness", "/tmp/close-harness");
    createSession("close-harness", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    const models = createModels();
    models.setProvider(provider.provider);
    let executionEnvCleanups = 0;
    const executionEnv = new NodeExecutionEnv({ cwd: "/tmp/close-harness" });
    executionEnv.cleanup = async () => { executionEnvCleanups++; };
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "close-harness", createdAt: 1, cwd: "/tmp/close-harness",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
      executionEnv,
    });
    let harnessCloses = 0;
    const nativeClose = runtime.harness.close.bind(runtime.harness);
    Object.defineProperty(runtime, "abort", { value: async () => { throw new Error("abort cleanup failed"); } });
    Object.defineProperty(runtime.harness, "close", { value: async (context: typeof BACKGROUND_CONTEXT) => { harnessCloses++; await nativeClose(context); } });

    const closing = runtime.close();
    await expect(closing).rejects.toThrow("abort cleanup failed");
    await expect(runtime.close()).rejects.toThrow("abort cleanup failed");
    expect(harnessCloses).toBe(1);
    expect(executionEnvCleanups).toBe(1);
  });

  test("aborts owned streaming work, clears steering, and lets wait observe settlement", async () => {
    const project = createProject("Abort Harness", "/tmp/abort-harness");
    createSession("abort-harness", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({
      models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }],
      tokensPerSecond: 5,
      tokenSize: { min: 1, max: 1 },
    });
    provider.setResponses([fauxAssistantMessage("a deliberately long streaming response")]);
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId: "abort-harness", createdAt: 1, cwd: "/tmp/abort-harness",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    const started = Promise.withResolvers<void>();
    let completion: unknown;
    runtime.subscribe((event) => {
      if (event.type === "message_update") started.resolve();
      if (event.type === "agent_end") completion = event;
    });

    await runtime.prompt([{ type: "text", text: "begin" }]);
    await started.promise;
    await runtime.steer([{ type: "text", text: "discard me" }]);
    const waiting = runtime.waitForIdle();
    await runtime.abort();
    await waiting;

    expect(runtime.isStreaming()).toBe(false);
    expect(completion).toMatchObject({
      type: "agent_end",
      runId: expect.any(String),
      status: "aborted",
    });
    expect(await runtime.getLastRunOutcome()).toMatchObject({ runId: expect.any(String), status: "aborted" });
    const watch = await runtime.lane.watch(BACKGROUND_CONTEXT);
    expect(watch.snapshot.queues).toEqual([]);
    watch.unsubscribe();
    await runtime.close();
  });
});
