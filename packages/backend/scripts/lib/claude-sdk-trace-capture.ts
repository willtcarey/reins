export interface TraceToolPlan {
  readPath: string;
  bashCommand: string;
}

export interface ClaudeSdkTraceArtifact {
  version: 2;
  capturedAt: string;
  cwd: string;
  sessionId: string;
  model: string;
  prompt: string;
  toolPlan: TraceToolPlan;
  sdkMessages: unknown[];
  error: unknown | null;
  summary: {
    sdkMessageTypes: string[];
    toolCallIds: string[];
    assistantSnapshotCount: number;
    userToolResultCount: number;
    resultSubtype: string | null;
    finalResultText: string;
  };
}

export function buildTracePrompt(toolPlan: TraceToolPlan): string {
  return [
    `Use the Read tool to read the file \`${toolPlan.readPath}\`.`,
    `Then use the Bash tool to run exactly this command: \`${toolPlan.bashCommand}\`.`,
    "After both tools complete, respond with a single short sentence that mentions what file you read and the bash output.",
    "Do not skip the tools, and do not answer before both tool calls are complete.",
  ].join("\n");
}

export function serializeForJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, currentValue: unknown) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    return currentValue;
  }));
}

function getSdkMessageType(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "unknown";
  const typed = entry as { type?: unknown; subtype?: unknown; event?: { type?: unknown } };
  const type = typeof typed.type === "string" ? typed.type : "unknown";
  const subtype = typeof typed.subtype === "string" ? typed.subtype : null;
  const eventType = typed.event && typeof typed.event.type === "string" ? typed.event.type : null;

  if (type === "stream_event" && eventType) return `${type}.${eventType}`;
  if (subtype) return `${type}.${subtype}`;
  return type;
}

function extractToolCallIds(sdkMessages: unknown[]): string[] {
  const ids = new Set<string>();

  for (const entry of sdkMessages) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as {
      event?: { content_block?: { type?: unknown; id?: unknown } };
      message?: { content?: Array<{ type?: unknown; id?: unknown; tool_use_id?: unknown }> };
      tool_use_id?: unknown;
      parent_tool_use_id?: unknown;
    };

    const contentBlock = typed.event?.content_block;
    if (contentBlock && contentBlock.type === "tool_use" && typeof contentBlock.id === "string") {
      ids.add(contentBlock.id);
    }

    const content = typed.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          ids.add(block.id);
        }
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          ids.add(block.tool_use_id);
        }
      }
    }

    if (typeof typed.tool_use_id === "string") ids.add(typed.tool_use_id);
    if (typeof typed.parent_tool_use_id === "string") ids.add(typed.parent_tool_use_id);
  }

  return [...ids];
}

function countAssistantSnapshots(sdkMessages: unknown[]): number {
  return sdkMessages.filter((entry) => {
    return Boolean(entry && typeof entry === "object" && (entry as { type?: unknown }).type === "assistant");
  }).length;
}

function countUserToolResultMessages(sdkMessages: unknown[]): number {
  return sdkMessages.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const typed = entry as {
      type?: unknown;
      parent_tool_use_id?: unknown;
      tool_use_result?: unknown;
      message?: { content?: Array<{ type?: unknown }> };
    };

    if (typed.type !== "user") return false;
    if (typed.parent_tool_use_id && typed.tool_use_result) return true;

    return Array.isArray(typed.message?.content)
      && typed.message.content.some((block) => block?.type === "tool_result");
  }).length;
}

function extractResultSummary(sdkMessages: unknown[]): { resultSubtype: string | null; finalResultText: string } {
  for (let index = sdkMessages.length - 1; index >= 0; index -= 1) {
    const entry = sdkMessages[index];
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as { type?: unknown; subtype?: unknown; result?: unknown };
    if (typed.type !== "result") continue;

    return {
      resultSubtype: typeof typed.subtype === "string" ? typed.subtype : null,
      finalResultText: typeof typed.result === "string" ? typed.result : "",
    };
  }

  return {
    resultSubtype: null,
    finalResultText: "",
  };
}

export function buildTraceArtifact(params: {
  cwd: string;
  sessionId: string;
  model: string;
  prompt: string;
  toolPlan: TraceToolPlan;
  sdkMessages: unknown[];
  error: unknown | null;
}): ClaudeSdkTraceArtifact {
  const resultSummary = extractResultSummary(params.sdkMessages);

  return {
    version: 2,
    capturedAt: new Date().toISOString(),
    cwd: params.cwd,
    sessionId: params.sessionId,
    model: params.model,
    prompt: params.prompt,
    toolPlan: params.toolPlan,
    sdkMessages: params.sdkMessages,
    error: params.error,
    summary: {
      sdkMessageTypes: params.sdkMessages.map(getSdkMessageType),
      toolCallIds: extractToolCallIds(params.sdkMessages),
      assistantSnapshotCount: countAssistantSnapshots(params.sdkMessages),
      userToolResultCount: countUserToolResultMessages(params.sdkMessages),
      resultSubtype: resultSummary.resultSubtype,
      finalResultText: resultSummary.finalResultText,
    },
  };
}
