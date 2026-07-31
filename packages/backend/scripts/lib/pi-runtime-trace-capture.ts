export interface PiTraceToolPlan {
  readPath: string;
  bashCommand: string;
}

export interface PiRuntimeTraceArtifact {
  version: 1;
  capturedAt: string;
  runtime: "pi";
  sdkPackage: string;
  workspace: string;
  model: { provider: string; id: string };
  prompt: string;
  toolPlan: PiTraceToolPlan;
  events: unknown[];
  finalMessages: unknown[];
  error: unknown | null;
  summary: {
    eventTypes: string[];
    messageLifecycle: Array<{
      eventIndex: number;
      type: string;
      role: string | null;
      timestamp: number | null;
      idFields: Record<string, string>;
    }>;
    toolExecutions: Array<{
      eventIndex: number;
      type: string;
      toolCallId: string;
      toolName: string;
    }>;
  };
}

export function buildPiTracePrompt(toolPlan: PiTraceToolPlan): string {
  return [
    `Use the read tool to read \`${toolPlan.readPath}\`.`,
    `Then use the bash tool to run exactly \`${toolPlan.bashCommand}\`.`,
    "Run the tools in that order, not in parallel.",
    "After both tools finish, reply with exactly: Pi trace complete.",
  ].join("\n");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return { type: "Uint8Array", data: [...value] };
  return value;
}

/** Snapshot an event immediately: Pi mutates the assistant message while streaming. */
export function snapshotForJson<T>(value: T, replacements: ReadonlyMap<string, string> = new Map()): T {
  const json = JSON.stringify(value, jsonReplacer);
  const sanitized = [...replacements.entries()]
    .toSorted(([left], [right]) => right.length - left.length)
    .reduce((text, [source, replacement]) => source ? text.replaceAll(source, replacement) : text, json);
  return JSON.parse(sanitized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function eventType(event: unknown): string {
  if (!isRecord(event)) return "unknown";
  const type = event["type"];
  return typeof type === "string" ? type : "unknown";
}

function collectIdFields(value: unknown, path = "message", result: Record<string, string> = {}): Record<string, string> {
  if (!isRecord(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (typeof child === "string" && /(^id$|id$|response.*id)/i.test(key)) {
      result[childPath] = child;
    } else if (child && typeof child === "object") {
      collectIdFields(child, childPath, result);
    }
  }
  return result;
}

export function buildPiTraceArtifact(params: {
  sdkPackage: string;
  model: { provider: string; id: string };
  prompt: string;
  toolPlan: PiTraceToolPlan;
  events: unknown[];
  finalMessages: unknown[];
  error: unknown | null;
}): PiRuntimeTraceArtifact {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    runtime: "pi",
    sdkPackage: params.sdkPackage,
    workspace: "<fixture-workspace>",
    model: params.model,
    prompt: params.prompt,
    toolPlan: params.toolPlan,
    events: params.events,
    finalMessages: params.finalMessages,
    error: params.error,
    summary: {
      eventTypes: params.events.map(eventType),
      messageLifecycle: params.events.flatMap((event, eventIndex) => {
        const type = eventType(event);
        if (!["message_start", "message_update", "message_end"].includes(type)) return [];
        const message = isRecord(event) ? event["message"] : undefined;
        const role = isRecord(message) ? message["role"] : undefined;
        const timestamp = isRecord(message) ? message["timestamp"] : undefined;
        return [{
          eventIndex,
          type,
          role: typeof role === "string" ? role : null,
          timestamp: typeof timestamp === "number" ? timestamp : null,
          idFields: collectIdFields(message),
        }];
      }),
      toolExecutions: params.events.flatMap((event, eventIndex) => {
        const type = eventType(event);
        if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)) return [];
        if (!isRecord(event)) return [];
        const toolCallId = event["toolCallId"];
        const toolName = event["toolName"];
        if (typeof toolCallId !== "string" || typeof toolName !== "string") return [];
        return [{ eventIndex, type, toolCallId, toolName }];
      }),
    },
  };
}
