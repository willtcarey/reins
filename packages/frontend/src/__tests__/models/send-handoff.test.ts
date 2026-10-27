import { describe, expect, test } from "bun:test";
import { SendHandoff } from "../../models/send-handoff.js";

const source = { rect: { left: 10, top: 500, width: 600, height: 40 } };

describe("SendHandoff", () => {
  test("gives the message sent to a session to its session once, and to no other", () => {
    const handoff = new SendHandoff();
    handoff.give({ sessionId: "s1", messageKey: "submission-1", source });

    expect(handoff.take("s2")).toBeNull();
    expect(handoff.take("s1")).toEqual({ sessionId: "s1", messageKey: "submission-1", source });
    expect(handoff.take("s1")).toBeNull();
  });

  test("keeps only the message handed off last", () => {
    const handoff = new SendHandoff();
    handoff.give({ sessionId: "s1", messageKey: "submission-1", source });
    handoff.give({ sessionId: "s2", messageKey: "submission-2", source });

    expect(handoff.take("s1")).toBeNull();
    expect(handoff.take("s2")?.messageKey).toBe("submission-2");
  });
});
