import { describe, expect, test } from "bun:test";
import { SessionContextUsage } from "../../components/session-context-usage.js";
import type { SessionContextSnapshot } from "@backend/models/session-context.js";
import { templateToString } from "../helpers/lit-template.js";

function render(overrides: Partial<SessionContextSnapshot> = {}) {
  const element = new SessionContextUsage();
  element.snapshot = {
    usedTokens: 42_000,
    contextWindow: 200_000,
    compactionThresholdTokens: 183_616,
    utilization: 0.21,
    measurement: "exact",
    ...overrides,
  };
  return templateToString(element.render());
}

describe("SessionContextUsage", () => {
  test("renders compact accessible occupancy detail in an interactive tooltip", () => {
    const output = render();

    expect(output).toContain('<button');
    expect(output).toContain("aria-label=Session context usage: 42k / 200k · 21%");
    expect(output).toContain("aria-expanded=");
    expect(output).toContain("@click=");
    expect(output).not.toContain("@pointerdown=");
    expect(output).not.toContain("@pointerenter=");
    expect(output).not.toContain("@focus=");
    expect(output).toContain('role="progressbar"');
    expect(output).toContain("aria-valuenow=21");
    expect(output).not.toContain('popover="manual"');
    expect(output).toContain("42k / 200k");
    expect(output).toContain("21%");
  });

  test("labels estimated occupancy", () => {
    expect(render({ usedTokens: 18_000, utilization: 0.09, measurement: "estimated" })).toContain("~18k / 200k");
  });

  test("announces warning states near and beyond the compaction threshold", () => {
    const near = render({ usedTokens: 170_000, utilization: 0.85 });
    expect(near).toContain("Context nearing compaction threshold");
    expect(near).toContain("aria-valuenow=85");

    const reached = render({ usedTokens: 190_000, utilization: 0.95 });
    expect(reached).toContain("Context compaction threshold reached");
    expect(reached).toContain("aria-valuenow=95");
  });
});
