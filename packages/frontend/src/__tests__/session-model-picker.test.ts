import { describe, expect, test } from "bun:test";
import { nothing, type TemplateResult } from "lit";
import { SessionModelPicker } from "../components/session-model-picker.js";

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

function templateToString(value: unknown): string {
  if (value == null || value === false || value === nothing) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => templateToString(entry)).join("");
  }
  if (isTemplateResult(value)) {
    let output = "";
    for (let index = 0; index < value.strings.length; index += 1) {
      output += value.strings[index] ?? "";
      if (index < value.values.length) {
        output += templateToString(value.values[index]);
      }
    }
    return output;
  }
  return "";
}

describe("SessionModelPicker", () => {
  test("anchors its popover upward from the composer area", () => {
    const el = new SessionModelPicker();
    el.sessionId = "sess-1";
    el.sessionData = {
      id: "sess-1",
      task_id: null,
      messages: [],
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 0,
      },
    };

    const output = templateToString(el.render());

    expect(output).toContain('anchor="right-end"');
  });
});
