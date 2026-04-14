import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { z } from "zod/v4";
import {
  createClaudeCustomToolsServer,
  typeboxToZodShape,
} from "../../../runtimes/claude_agent_sdk/tools.js";

/** Returns the input value typed as `any` — test-only escape hatch to avoid `as` assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function untyped(value: unknown): any { return value; }

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>;

describe("typeboxToZodShape", () => {
  test("converts required string properties", () => {
    const schema = Type.Object({
      prompt: Type.String({ description: "The prompt" }),
    });

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);
    const result = z.safeParse(zodObj, { prompt: "hello" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ prompt: "hello" });
    }
  });

  test("converts optional string properties", () => {
    const schema = Type.Object({
      prompt: Type.String(),
      modelId: Type.Optional(Type.String()),
    });

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);

    // With optional omitted
    const result1 = z.safeParse(zodObj, { prompt: "hello" });
    expect(result1.success).toBe(true);

    // With optional present
    const result2 = z.safeParse(zodObj, { prompt: "hello", modelId: "claude-4" });
    expect(result2.success).toBe(true);
    if (result2.success) {
      expect(result2.data).toEqual({ prompt: "hello", modelId: "claude-4" });
    }
  });

  test("rejects missing required properties", () => {
    const schema = Type.Object({
      prompt: Type.String(),
    });

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);
    const result = z.safeParse(zodObj, {});

    expect(result.success).toBe(false);
  });

  test("converts number and integer properties", () => {
    const schema = Type.Object({
      count: Type.Number(),
      index: Type.Integer(),
    });

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);
    const result = z.safeParse(zodObj, { count: 1.5, index: 3 });

    expect(result.success).toBe(true);
  });

  test("converts boolean properties", () => {
    const schema = Type.Object({
      enabled: Type.Boolean(),
    });

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);
    const result = z.safeParse(zodObj, { enabled: true });

    expect(result.success).toBe(true);
  });

  test("converts array properties", () => {
    const schema = Type.Object({
      items: Type.Array(Type.String()),
    });

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);
    const result = z.safeParse(zodObj, { items: ["a", "b"] });

    expect(result.success).toBe(true);
  });

  test("converts object properties", () => {
    const schema = Type.Object({
      config: Type.Object({ key: Type.String() }),
    });

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);
    const result = z.safeParse(zodObj, { config: { key: "val" } });

    expect(result.success).toBe(true);
  });

  test("handles empty object schema", () => {
    const schema = Type.Object({});

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);
    const result = z.safeParse(zodObj, {});

    expect(result.success).toBe(true);
  });

  test("produces shapes compatible with safeParseAsync", async () => {
    const schema = Type.Object({
      prompt: Type.String(),
      modelProvider: Type.Optional(Type.String()),
      modelId: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
    });

    const shape = typeboxToZodShape(schema);
    const zodObj = z.object(shape);

    // This is the exact path the MCP SDK takes
    const result = await z.safeParseAsync(zodObj, {
      prompt: "Do some work",
    });

    expect(result.success).toBe(true);
  });

  test("custom tool handlers read the active runtime abort signal at execution time when MCP does not provide one", async () => {
    const observedSignals: AbortSignal[] = [];
    let currentController = new AbortController();

    const server = createClaudeCustomToolsServer({
      customTools: untyped([{
        name: "delegate",
        description: "Run delegated work",
        parameters: Type.Object({ prompt: Type.String() }),
        execute: async (_toolCallId: string, _args: unknown, signal?: AbortSignal) => {
          if (signal) observedSignals.push(signal);
          return { content: [{ type: "text" as const, text: signal?.aborted ? "aborted" : "running" }] };
        },
      }]),
      getSignal: () => currentController.signal,
    });

    expect(server).not.toBeNull();

    const registeredTools = Reflect.get(server!.instance, "_registeredTools");
    const handler: ToolHandler = registeredTools.delegate.handler;

    await handler({ prompt: "first" });
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]).toBe(currentController.signal);
    expect(observedSignals[0]?.aborted).toBe(false);

    currentController.abort();
    expect(observedSignals[0]?.aborted).toBe(true);

    currentController = new AbortController();
    await handler({ prompt: "second" });

    expect(observedSignals).toHaveLength(2);
    expect(observedSignals[1]).toBe(currentController.signal);
    expect(observedSignals[1]).not.toBe(observedSignals[0]);
    expect(observedSignals[1]?.aborted).toBe(false);
  });

  test("custom tool handlers use the MCP-provided abort signal when present", async () => {
    const observedSignals: AbortSignal[] = [];
    const runtimeController = new AbortController();
    const mcpController = new AbortController();

    const server = createClaudeCustomToolsServer({
      customTools: untyped([{
        name: "delegate",
        description: "Run delegated work",
        parameters: Type.Object({ prompt: Type.String() }),
        execute: async (_toolCallId: string, _args: unknown, signal?: AbortSignal) => {
          if (signal) observedSignals.push(signal);
          return { content: [{ type: "text" as const, text: signal?.aborted ? "aborted" : "running" }] };
        },
      }]),
      getSignal: () => runtimeController.signal,
    });

    const registeredTools = Reflect.get(server!.instance, "_registeredTools");
    const handler: ToolHandler = registeredTools.delegate.handler;

    await handler({ prompt: "first" }, { signal: mcpController.signal });

    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]).not.toBe(runtimeController.signal);
    expect(observedSignals[0]).not.toBe(mcpController.signal);
    expect(observedSignals[0]?.aborted).toBe(false);

    mcpController.abort();
    expect(observedSignals[0]?.aborted).toBe(true);
  });

  test("custom tool handlers combine runtime and MCP abort signals so either one cancels the tool", async () => {
    const observedSignals: AbortSignal[] = [];
    const runtimeController = new AbortController();
    const mcpController = new AbortController();

    const server = createClaudeCustomToolsServer({
      customTools: untyped([{
        name: "delegate",
        description: "Run delegated work",
        parameters: Type.Object({ prompt: Type.String() }),
        execute: async (_toolCallId: string, _args: unknown, signal?: AbortSignal) => {
          if (signal) observedSignals.push(signal);
          return { content: [{ type: "text" as const, text: signal?.aborted ? "aborted" : "running" }] };
        },
      }]),
      getSignal: () => runtimeController.signal,
    });

    const registeredTools = Reflect.get(server!.instance, "_registeredTools");
    const handler: ToolHandler = registeredTools.delegate.handler;

    await handler({ prompt: "first" }, { signal: mcpController.signal });
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(false);

    runtimeController.abort();
    expect(observedSignals[0]?.aborted).toBe(true);
  });
});
