import { describe, expect, test, afterEach } from "bun:test";
import { SettingsPanel } from "../../../components/settings/panel.js";
import { SettingsStore } from "../../../models/stores/settings-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { isTemplateResult, templateToString } from "../../helpers/lit-template.js";

type TestGlobal = typeof globalThis & { REINS_DEV?: boolean };
const testGlobal: TestGlobal = globalThis;

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function templateContainsValue(value: unknown, target: unknown): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((entry) => templateContainsValue(entry, target));
  if (isTemplateResult(value)) return value.values.some((entry) => templateContainsValue(entry, target));
  return false;
}

function makePanel(store = new SettingsStore()): SettingsPanel {
  const el = new SettingsPanel();
  el.store = store;
  return el;
}

function mockSettingsPanelFetch(modelsResponse: Response | Promise<Response> = jsonResponse([])): string[] {
  const requests: string[] = [];
  mockFetch((url) => {
    requests.push(url);
    if (url.startsWith("/api/settings")) return jsonResponse([]);
    if (url === "/api/oauth/providers") return jsonResponse([]);
    if (url === "/api/models") return modelsResponse;
    return jsonResponse({}, false);
  });
  return requests;
}

describe("SettingsPanel", () => {
  afterEach(() => {
    delete testGlobal.REINS_DEV;
    restoreFetch();
  });

  test("renders nothing while closed", () => {
    const el = makePanel();

    expect(templateToString(el.render())).toBe("");
  });


  test("renders visible settings after settings load while the model registry is still loading", async () => {
    const modelRegistry = deferred<Response>();
    mockSettingsPanelFetch(modelRegistry.promise);

    const el = makePanel();
    el.open();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = templateToString(el.render());

    expect(output).toContain("Settings");
    expect(output).toContain("<settings-api-keys-section");
    expect(output).toContain("Default Model");
    expect(output).toContain("Utility Model");
    expect(output).not.toContain("Loading settings...");

    modelRegistry.resolve(jsonResponse([]));
  });

  test("hides the diff renderer setting outside frontend dev builds", async () => {
    const requests = mockSettingsPanelFetch();

    const el = makePanel();
    el.open();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = templateToString(el.render());

    expect(output).not.toContain("<settings-diff-renderer-section");
    expect(requests).toContain("/api/settings?key=default_model&key=utility_model");
  });

  test("renders with an injected shared settings store", () => {
    testGlobal.REINS_DEV = true;
    const store = new SettingsStore();

    const el = makePanel(store);
    Reflect.set(el, "_open", true);

    expect(templateContainsValue(el.render(), store)).toBe(true);
  });

  test("renders the diff renderer setting in frontend dev builds", async () => {
    testGlobal.REINS_DEV = true;
    const requests = mockSettingsPanelFetch();

    const el = makePanel();
    el.open();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = templateToString(el.render());

    expect(output).toContain("<settings-diff-renderer-section");
    expect(requests).toContain("/api/settings?key=default_model&key=diff_renderer&key=utility_model");
  });
});
