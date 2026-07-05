import { describe, expect, test } from "bun:test";
import { SettingsDiffRendererSection } from "../../../components/settings/diff-renderer-section.js";
import { SettingsStore } from "../../../models/stores/settings-store.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("SettingsDiffRendererSection", () => {
  test("renders diff renderer options and experimental note", () => {
    const store = new SettingsStore();
    store.diffRenderer = "codeview";

    const el = new SettingsDiffRendererSection();
    el.store = store;

    const output = templateToString(el.render());

    expect(output).toContain("Diff renderer");
    expect(output).toContain("Classic");
    expect(output).toContain("CodeView diff panel");
    expect(output).toContain("experimental");
    expect(output).toContain("may not match every classic feature yet");
    expect(output).not.toContain("?disabled=");
  });
});
