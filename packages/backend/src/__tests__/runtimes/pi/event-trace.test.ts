import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/tool-trace.json";

type RawEvent = {
  type: string;
  message?: {
    role?: string;
    timestamp?: number;
    responseId?: string;
    content?: Array<{ type?: string; id?: string }>;
    [key: string]: unknown;
  };
  toolCallId?: string;
  toolName?: string;
};

const events: RawEvent[] = fixture.events;

describe("captured Pi AgentSession event trace", () => {
  test("contains a successful multi-turn run using read and bash", () => {
    expect(fixture.error).toBeNull();
    expect(fixture.summary.eventTypes).toEqual(events.map((event) => event.type));

    const starts = events.filter((event) => event.type === "tool_execution_start");
    const ends = events.filter((event) => event.type === "tool_execution_end");
    expect(starts.map((event) => event.toolName)).toEqual(["read", "bash"]);
    expect(ends.map((event) => event.toolName)).toEqual(["read", "bash"]);
    expect(ends.map((event) => event.toolCallId)).toEqual(starts.map((event) => event.toolCallId));
  });

  test("preserves assistant lifecycle identity and observed event ordering", () => {
    const assistantLifecycle = events.filter((event) =>
      ["message_start", "message_update", "message_end"].includes(event.type)
      && event.message?.role === "assistant"
    );
    const assistantStarts = assistantLifecycle.filter((event) => event.type === "message_start");
    const assistantEnds = assistantLifecycle.filter((event) => event.type === "message_end");

    expect(assistantStarts.length).toBeGreaterThanOrEqual(2);
    expect(assistantEnds).toHaveLength(assistantStarts.length);

    const finalMessages: RawEvent["message"][] = fixture.finalMessages;
    const finalAssistants = finalMessages.filter((message) => message?.role === "assistant");
    expect(finalAssistants).toHaveLength(assistantStarts.length);

    for (const start of assistantStarts) {
      const end = assistantEnds.find((candidate) => candidate.message?.timestamp === start.message?.timestamp);
      expect(end).toBeDefined();
      const lifecycle = assistantLifecycle.filter((event) => event.message?.timestamp === start.message?.timestamp);
      expect(lifecycle[0]?.type).toBe("message_start");
      expect(lifecycle.at(-1)?.type).toBe("message_end");
      expect(new Set(lifecycle.map((event) => event.message?.timestamp)).size).toBe(1);

      // Pi's message_start has no provider response ID. The first update adds one,
      // and that response ID then remains stable through message_end.
      expect(start.message?.responseId).toBeUndefined();
      const responseIds = lifecycle
        .map((event) => event.message?.responseId)
        .filter((id): id is string => typeof id === "string");
      expect(responseIds.length).toBeGreaterThan(0);
      expect(new Set(responseIds).size).toBe(1);
      expect(finalAssistants).toContainEqual(expect.objectContaining({
        timestamp: start.message?.timestamp,
        responseId: responseIds[0],
      }));
    }

    const toolStarts = events.filter((event) => event.type === "tool_execution_start");
    for (const toolStart of toolStarts) {
      const assistantEnd = events.find((event) =>
        event.type === "message_end"
        && event.message?.role === "assistant"
        && event.message.content?.some((block) => block.type === "toolCall" && block.id === toolStart.toolCallId)
      );
      expect(assistantEnd).toBeDefined();
    }

    const firstAssistantEnd = events.findIndex((event) =>
      event.type === "message_end" && event.message?.role === "assistant"
    );
    const firstToolStart = events.findIndex((event) => event.type === "tool_execution_start");
    const firstToolEnd = events.findIndex((event) => event.type === "tool_execution_end");
    const firstToolResultStart = events.findIndex((event) =>
      event.type === "message_start" && event.message?.role === "toolResult"
    );
    expect(firstAssistantEnd).toBeLessThan(firstToolStart);
    expect(firstToolStart).toBeLessThan(firstToolEnd);
    expect(firstToolEnd).toBeLessThan(firstToolResultStart);
  });
});
