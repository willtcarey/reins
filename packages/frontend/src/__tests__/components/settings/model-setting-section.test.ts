import { describe, expect, test } from "bun:test";
import { SettingsModelSettingSection } from "../../../components/settings/model-setting-section.js";
import { SettingsStore } from "../../../models/stores/settings-store.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("SettingsModelSettingSection", () => {
  test("shows a local loading state while the model registry loads", () => {
    const store = new SettingsStore();
    store.registryStore.loading = true;

    const el = new SettingsModelSettingSection();
    el.store = store;

    const output = templateToString(el.render());

    expect(output).toContain("Loading model registry...");
    expect(output).not.toContain("model-selector-controls");
  });
});
