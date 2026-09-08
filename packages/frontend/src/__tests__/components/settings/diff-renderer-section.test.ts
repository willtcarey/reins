import { describe, expect, test } from "bun:test";
import { SettingsDiffRendererSection } from "../../../components/settings/diff-renderer-section.js";
import { SettingsStore } from "../../../models/stores/settings-store.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("SettingsDiffRendererSection", () => {
  test("renders the Classic and Reins renderer options", () => {
    const store = new SettingsStore();
    store.diffRenderer = "virtualized";

    const el = new SettingsDiffRendererSection();
    el.store = store;

    const output = templateToString(el.render());

    expect(output).toContain("Diff renderer");
    expect(output).toContain("Classic");
    expect(output).toContain("Reins virtualized diff");
    expect(output).not.toContain("CodeView");
    expect(output).not.toContain("?disabled=");
  });
});
