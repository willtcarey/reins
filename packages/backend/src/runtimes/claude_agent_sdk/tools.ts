import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { z } from "zod/v4";
import type { TSchema } from "@sinclair/typebox";
import { isRecord, toRecord } from "./type-guards.js";

/**
 * Convert a TypeBox TObject schema (JSON Schema format) to a Zod v4 raw shape.
 *
 * The Claude Agent SDK's `createSdkMcpServer` expects Zod raw shapes for
 * `inputSchema`, but our custom tools use TypeBox. This bridge converts the
 * JSON Schema properties to equivalent Zod types so the SDK's internal
 * validation (via `safeParseAsync`) works correctly.
 */
export function typeboxToZodShape(schema: TSchema): z.core.$ZodShape {
  const schemaObj = toRecord(schema);
  const properties = toRecord(schemaObj.properties);
  const rawRequired = schemaObj.required;
  const required: string[] = Array.isArray(rawRequired)
    ? rawRequired.filter((x): x is string => typeof x === "string")
    : [];

  const shape: Record<string, z.ZodType> = {};
  for (const [key, rawProp] of Object.entries(properties)) {
    const prop = toRecord(rawProp);
    let zodType: z.ZodType;
    switch (prop.type) {
      case "number":
      case "integer":
        zodType = z.number();
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      case "array":
        zodType = z.array(z.any());
        break;
      case "object":
        zodType = z.record(z.string(), z.any());
        break;
      case "string":
      default:
        zodType = z.string();
        break;
    }
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }
    shape[key] = zodType;
  }
  return shape;
}

function formatToolResult(result: unknown): string {
  if (!isRecord(result)) return "";

  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("\n");
    if (text.trim().length > 0) return text;
  }

  return JSON.stringify(result);
}

function getMcpSignal(extra: unknown): AbortSignal | undefined {
  if (!isRecord(extra)) return undefined;
  const signal = extra.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function resolveToolSignal(runtimeSignal: AbortSignal, extra: unknown): AbortSignal {
  const mcpSignal = getMcpSignal(extra);
  if (!mcpSignal || mcpSignal === runtimeSignal) {
    return runtimeSignal;
  }

  return AbortSignal.any([runtimeSignal, mcpSignal]);
}

export function createClaudeCustomToolsServer(params: {
  customTools: ToolDefinition[];
  getSignal: () => AbortSignal;
}): McpSdkServerConfigWithInstance | null {
  const { customTools, getSignal } = params;
  if (!customTools.length) return null;

  return createSdkMcpServer({
    name: "custom-tools",
    version: "1.0.0",
    tools: customTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: typeboxToZodShape(tool.parameters),
      handler: async (args: Record<string, unknown>, extra: unknown) => {
        const toolCallId = crypto.randomUUID();
        const result = await tool.execute(toolCallId, args, resolveToolSignal(getSignal(), extra), undefined, Object.create(null));
        return {
          content: [{ type: "text", text: formatToolResult(result) }],
          isError: false,
        };
      },
    })),
  });
}
