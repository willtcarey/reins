import { describe, expect, test } from "bun:test";
import { SettingsApiKeysSection } from "../../../components/settings/api-keys-section.js";
import { SettingsStore } from "../../../models/stores/settings-store.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("SettingsApiKeysSection", () => {
  test("renders the API Keys header inline with the + trigger", () => {
    const store = new SettingsStore();
    store.registryStore.providers = [
      {
        runtimeType: "pi",
        provider: "anthropic",
        isAvailable: true,
        availabilitySource: "db",
        availabilitySources: ["db"],
        models: [],
      },
      {
        runtimeType: "pi",
        provider: "openai",
        isAvailable: false,
        availabilitySource: null,
        availabilitySources: [],
        models: [],
      },
    ];

    const el = new SettingsApiKeysSection();
    el.store = store;

    const output = templateToString(el.render());

    expect(output).toContain('class="flex items-center justify-between gap-2"');
    expect(output).toContain(">API Keys</h3>");
    expect(output).toContain('aria-label="Add new provider"');
    expect(output).toContain('title="Add new provider"');
    expect(output).toContain(">+</button>");
    expect(output).not.toContain("Add API key...");
  });
});
