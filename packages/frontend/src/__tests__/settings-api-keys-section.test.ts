import { describe, expect, test } from "bun:test";
import { SettingsApiKeysSection } from "../components/settings/api-keys-section.js";
import { ModelRegistryStore } from "../models/stores/model-registry-store.js";
import { SettingsStore } from "../models/stores/settings-store.js";
import { templateToString } from "./helpers/lit-template.js";

describe("SettingsApiKeysSection", () => {
  test("renders the API Keys header inline with the + trigger", () => {
    const store = new SettingsStore();
    const registryStore = new ModelRegistryStore();
    registryStore.providers = [
      {
        provider: "anthropic",
        isAvailable: true,
        availabilitySource: "db",
        availabilitySources: ["db"],
        models: [],
      },
      {
        provider: "openai",
        isAvailable: false,
        availabilitySource: null,
        availabilitySources: [],
        models: [],
      },
    ];

    const el = new SettingsApiKeysSection();
    el.store = store;
    el.registryStore = registryStore;

    const output = templateToString(el.render());

    expect(output).toContain('class="flex items-center justify-between gap-2"');
    expect(output).toContain(">API Keys</h3>");
    expect(output).toContain('aria-label="Add new provider"');
    expect(output).toContain('title="Add new provider"');
    expect(output).toContain(">+</button>");
    expect(output).not.toContain("Add API key...");
  });
});
