import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/compaction-trace.json";

type TraceEvent = {
  sequence: number;
  isStreaming: boolean;
  isCompacting: boolean;
  event: {
    type: string;
    reason?: string;
    willRetry?: boolean;
    aborted?: boolean;
  };
};

const events: TraceEvent[] = fixture.events;

function eventOfType(type: string): TraceEvent {
  const observation = events.find(({ event }) => event.type === type);
  expect(observation).toBeDefined();
  return observation!;
}

describe("captured Pi threshold compaction trace", () => {
  test("records the observed post-agent lifecycle without a retry", () => {
    expect(fixture.error).toBeNull();
    expect(fixture.trigger.kind).toBe("threshold-after-agent-end");

    const lifecycle = events
      .map(({ event }) => event.type)
      .filter((type) => [
        "agent_start",
        "turn_start",
        "message_start",
        "message_end",
        "turn_end",
        "agent_end",
        "compaction_start",
        "compaction_end",
        "agent_settled",
      ].includes(type));
    expect(lifecycle).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
      "compaction_start",
      "compaction_end",
      "agent_settled",
    ]);

    expect(eventOfType("compaction_start").event).toMatchObject({
      reason: "threshold",
    });
    expect(eventOfType("compaction_end").event).toMatchObject({
      reason: "threshold",
      aborted: false,
      willRetry: false,
    });
  });

  test("remains streaming through compaction and becomes idle at settlement", () => {
    expect(eventOfType("agent_end").isStreaming).toBe(true);
    expect(eventOfType("compaction_start").isStreaming).toBe(true);
    expect(eventOfType("compaction_end").isStreaming).toBe(true);
    expect(eventOfType("agent_settled").isStreaming).toBe(false);

    expect(fixture.promptStates.map(({ phase, isStreaming }) => ({ phase, isStreaming }))).toEqual([
      { phase: "before_prompt_call", isStreaming: false },
      { phase: "immediately_after_prompt_call", isStreaming: false },
      { phase: "after_prompt_settlement", isStreaming: false },
    ]);
  });
});
