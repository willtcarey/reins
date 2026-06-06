import { describe, expect, test } from "bun:test";
import { computeConversationShiftDeltas, computeSendAnimationGeometry, computeSendAnimationStages } from "../../helpers/chat-send-animation.js";

describe("conversation shift animation", () => {
  test("computes FLIP deltas so existing bubbles animate upward from their previous positions", () => {
    const deltas = computeConversationShiftDeltas(
      [
        { key: "user-1", left: 24, top: 420 },
        { key: "assistant-2", left: 16, top: 500 },
      ],
      [
        { key: "user-1", left: 24, top: 340 },
        { key: "assistant-2", left: 16, top: 420 },
        { key: "user-3", left: 180, top: 520 },
      ],
    );

    expect(deltas).toEqual([
      { key: "user-1", dx: 0, dy: 80 },
      { key: "assistant-2", dx: 0, dy: 80 },
    ]);
  });
});

describe("send animation geometry", () => {
  test("uses one continuous travel stage without a midpoint handoff", () => {
    const stages = computeSendAnimationStages({ dx: 220, dy: -200 });

    expect(Object.keys(stages).toSorted()).toEqual(["durationMs", "finalDx", "finalDy", "scale"].toSorted());
    expect(stages.finalDx).toBe(220);
    expect(stages.finalDy).toBe(-200);
    expect(stages.scale).toBe(1);
    expect(stages.durationMs).toBe(220);
  });

  test("starts short prompts at bubble width while staying anchored to the prompt start", () => {
    const geometry = computeSendAnimationGeometry(
      { left: 100, top: 400, width: 300, height: 44 },
      { left: 320, top: 200, width: 80, height: 32 },
      { left: 0, top: 0, width: 400, height: 700 },
    );

    expect(geometry.startWidth).toBe(80);
    expect(geometry.startLeft).toBe(100);
    expect(geometry.dx).toBe(220);
  });

  test("caps the starting width at the composer width for long prompts", () => {
    const geometry = computeSendAnimationGeometry(
      { left: 100, top: 400, width: 220, height: 44 },
      { left: 40, top: 200, width: 280, height: 72 },
      { left: 0, top: 0, width: 400, height: 700 },
    );

    expect(geometry.startWidth).toBe(220);
    expect(geometry.startLeft).toBe(100);
    expect(geometry.dx).toBe(-60);
  });
});
