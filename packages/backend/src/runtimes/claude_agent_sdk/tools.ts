import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { z } from "zod/v4";
import type { TSchema } from "@sinclair/typebox";

/**
 * Convert a TypeBox TObject schema (JSON Schema format) to a Zod v4 raw shape.
 *
 * The Claude Agent SDK's `createSdkMcpServer` expects Zod raw shapes for
 * `inputSchema`, but our custom tools use TypeBox. This bridge converts the
 * JSON Schema properties to equivalent Zod types so the SDK's internal
 * validation (via `safeParseAsync`) works correctly.
 */
export function typeboxToZodShape(schema: TSchema): z.core.$ZodShape {
  const properties = (schema as any).properties ?? {};
  const required: string[] = (schema as any).required ?? [];

  const shape: z.core.$ZodShape = {};
  for (const [key, prop] of Object.entries<any>(properties)) {
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
  if (!result || typeof result !== "object") return "";
  const typed = result as Record<string, unknown>;

  if (Array.isArray(typed.content)) {
    const text = typed.content
      .filter((block) => block && typeof block === "object" && (block as any).type === "text")
      .map((block) => String((block as any).text ?? ""))
      .join("\n");
    if (text.trim().length > 0) return text;
  }

  return JSON.stringify(result);
}

function getMcpSignal(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const signal = (extra as { signal?: unknown }).signal;
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
        const result = await tool.execute(toolCallId, args, resolveToolSignal(getSignal(), extra), undefined, {} as any);
        return {
          content: [{ type: "text", text: formatToolResult(result) }],
          isError: false,
        };
      },
    })),
  });
}
