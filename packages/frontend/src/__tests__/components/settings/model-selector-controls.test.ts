import { describe, expect, test } from "bun:test";
import { ModelSelectorControls } from "../../../components/settings/model-selector-controls.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("ModelSelectorControls", () => {
  test("keeps model controls enabled while saves happen in the background", () => {
    const el = new ModelSelectorControls();
    el.providers = [
      {
        runtimeType: "pi",
        provider: "anthropic",
        isAvailable: true,
        availabilitySource: "db",
        availabilitySources: ["db"],
        models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true }],
      },
    ];
    el.selectedRuntimeType = "pi";
    el.selectedProvider = "anthropic";
    el.selectedModel = "claude-sonnet-4";

    const output = templateToString(el.render());

    expect(output).not.toContain("?disabled=");
  });
});
