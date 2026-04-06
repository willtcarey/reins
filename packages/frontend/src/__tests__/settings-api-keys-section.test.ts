import { describe, expect, test } from "bun:test";
import { nothing, type TemplateResult } from "lit";
import { SettingsApiKeysSection } from "../components/settings/api-keys-section.js";
import { ModelCatalogStore } from "../models/stores/model-catalog-store.js";
import { SettingsStore } from "../models/stores/settings-store.js";

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
    const template: TemplateResult = value;
    let output = "";
    for (let index = 0; index < template.strings.length; index += 1) {
      output += template.strings[index] ?? "";
      if (index < template.values.length) {
        output += templateToString(template.values[index]);
      }
    }
    return output;
  }
  return "";
}

describe("SettingsApiKeysSection", () => {
  test("renders the API Keys header inline with the + trigger", () => {
    const store = new SettingsStore();
    const catalogStore = new ModelCatalogStore();
    catalogStore.providers = [
      {
        provider: "anthropic",
        hasKey: true,
        keySource: "db",
        keySources: ["db"],
        models: [],
      },
      {
        provider: "openai",
        hasKey: false,
        keySource: null,
        keySources: [],
        models: [],
      },
    ];

    const el = new SettingsApiKeysSection();
    el.store = store;
    el.catalogStore = catalogStore;

    const output = templateToString(el.render());

    expect(output).toContain('class="flex items-center justify-between gap-2"');
    expect(output).toContain(">API Keys</h3>");
    expect(output).toContain('aria-label="Add new provider"');
    expect(output).toContain('title="Add new provider"');
    expect(output).toContain(">+</button>");
    expect(output).not.toContain("Add API key...");
  });
});
