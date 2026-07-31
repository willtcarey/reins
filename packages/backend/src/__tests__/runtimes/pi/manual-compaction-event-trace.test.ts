import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/manual-compaction-trace.json";

type TraceEvent = {
  sequence: number;
  isStreaming: boolean;
  isCompacting: boolean;
  event: {
    type: string;
    reason?: string;
    willRetry?: boolean;
    aborted?: boolean;
    result?: unknown;
  };
};

type StateObservation = {
  phase: string;
  eventCount: number;
  isStreaming: boolean;
  isCompacting: boolean;
};

const events: TraceEvent[] = fixture.events;
const states: StateObservation[] = fixture.compactionStates;

function eventOfType(type: string): TraceEvent {
  const observation = events.find(({ event }) => event.type === type);
  expect(observation).toBeDefined();
  return observation!;
}

function stateAt(phase: string): StateObservation {
  const observation = states.find((state) => state.phase === phase);
  expect(observation).toBeDefined();
  return observation!;
}

describe("captured Pi manual compaction trace", () => {
  test("uses the direct AgentSession entrypoint after a settled seed run", () => {
    expect(fixture.error).toBeNull();
    expect(fixture.sdkPackage).toBe("@earendil-works/pi-coding-agent@0.80.6");
    expect(fixture.invocation).toMatchObject({
      entrypoint: "AgentSession.compact(customInstructions?: string)",
      compactionSettings: { enabled: false, keepRecentTokens: 1 },
    });

    expect(fixture.summary.manualEventTypes).toEqual([
      "compaction_start",
      "compaction_end",
    ]);
    expect(eventOfType("agent_settled").sequence).toBeLessThan(eventOfType("compaction_start").sequence);
  });

  test("emits only manual compaction boundaries, with no agent lifecycle", () => {
    const start = eventOfType("compaction_start");
    const manualEvents = events.slice(start.sequence);

    expect(manualEvents.map(({ event }) => event.type)).toEqual([
      "compaction_start",
      "compaction_end",
    ]);
    expect(manualEvents.some(({ event }) => event.type === "agent_start")).toBeFalse();
    expect(manualEvents.some(({ event }) => event.type === "agent_end")).toBeFalse();
    expect(manualEvents.some(({ event }) => event.type === "agent_settled")).toBeFalse();

    expect(start.event).toMatchObject({ reason: "manual" });
    expect(eventOfType("compaction_end").event).toMatchObject({
      reason: "manual",
      aborted: false,
      willRetry: false,
    });
  });

  test("is non-streaming and compacting at both event callbacks", () => {
    expect(eventOfType("compaction_start")).toMatchObject({
      isStreaming: false,
      isCompacting: true,
    });
    expect(eventOfType("compaction_end")).toMatchObject({
      isStreaming: false,
      isCompacting: true,
    });
  });

  test("clears compacting before the compact promise fulfills", () => {
    expect(stateAt("before_compact_call")).toMatchObject({
      isStreaming: false,
      isCompacting: false,
    });
    expect(stateAt("immediately_after_compact_call")).toMatchObject({
      eventCount: eventOfType("compaction_start").sequence,
      isStreaming: false,
      isCompacting: false,
    });
    expect(stateAt("compaction_end_callback_before_promise_settlement")).toMatchObject({
      eventCount: events.length,
      isStreaming: false,
      isCompacting: true,
    });
    expect(stateAt("compaction_promise_fulfilled")).toMatchObject({
      eventCount: events.length,
      isStreaming: false,
      isCompacting: false,
    });
    expect(stateAt("after_compact_await")).toMatchObject({
      eventCount: events.length,
      isStreaming: false,
      isCompacting: false,
    });
  });

  test("appends a compaction entry and replaces summarized context", () => {
    expect(fixture.entriesBefore.map(({ type }) => type)).not.toContain("compaction");
    expect(fixture.entriesAfter.map(({ type }) => type)).toEqual([
      ...fixture.entriesBefore.map(({ type }) => type),
      "compaction",
    ]);
    expect(fixture.messagesBefore.map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(fixture.messagesAfter.map(({ role }) => role)).toEqual(["compactionSummary", "assistant"]);
    expect(fixture.messagesAfter[0]).toMatchObject({
      role: "compactionSummary",
      summary: fixture.compactionResult.summary,
    });
    expect(fixture.compactionResult).toMatchObject({
      firstKeptEntryId: expect.any(String),
      tokensBefore: expect.any(Number),
      estimatedTokensAfter: expect.any(Number),
    });
  });
});
