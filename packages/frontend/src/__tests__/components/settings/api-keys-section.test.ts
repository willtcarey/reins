import { describe, expect, test } from "bun:test";
import { SettingsApiKeysSection } from "../../../components/settings/api-keys-section.js";
import { SettingsStore } from "../../../models/stores/settings-store.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("SettingsApiKeysSection", () => {
  test("lists configured providers and offers to add only the others", () => {
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

    const addOptions = output.slice(output.indexOf("<select"), output.indexOf("</select>"));

    expect(output).toContain(">Anthropic</span>");
    expect(output).toContain("Add provider</button>");
    expect(addOptions).toContain(">Openai</option>");
    expect(addOptions).not.toContain("anthropic");
  });
});
