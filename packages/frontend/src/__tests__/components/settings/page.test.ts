import { afterEach, describe, expect, test } from "bun:test";
import { SettingsPage } from "../../../components/settings/page.js";
import { SettingsStore } from "../../../models/stores/settings-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { collectTemplateValues, templateToString } from "../../helpers/lit-template.js";

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

function installViewport(options: { mobile: boolean }) {
  Reflect.set(globalThis, "navigator", { standalone: false });
  Reflect.set(globalThis, "window", {
    matchMedia: (query: string) => ({
      matches: query.includes("max-width") ? options.mobile : false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mockSettingsFetch(modelsResponse: Response | Promise<Response> = jsonResponse([])): string[] {
  const requests: string[] = [];
  mockFetch((url) => {
    requests.push(url);
    if (url.startsWith("/api/settings")) return jsonResponse([]);
    if (url === "/api/oauth/providers") return jsonResponse([]);
    if (url === "/api/models") return modelsResponse;
    if (url === "/api/nodes") return jsonResponse([]);
    return new Response("{}", { status: 500 });
  });
  return requests;
}

/** The page as rendered and loaded for a route's section. */
async function showPage(section: SettingsPage["section"], store = new SettingsStore()): Promise<SettingsPage> {
  const page = new SettingsPage();
  page.store = store;
  page.section = section;
  page.willUpdate(new Map());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return page;
}

function fullOutput(page: SettingsPage): string {
  const rendered = page.render();
  return `${templateToString(rendered)}\n${templateToString(collectTemplateValues(rendered))}`;
}

afterEach(() => {
  restoreFetch();
  Reflect.set(globalThis, "window", originalWindow);
  Reflect.set(globalThis, "navigator", originalNavigator);
});

describe("SettingsPage", () => {
  test("on desktop, the bare settings URL shows the section nav and loads only the Models section", async () => {
    installViewport({ mobile: false });
    const requests = mockSettingsFetch();

    const output = fullOutput(await showPage(null));

    expect(output).toContain("Settings sections");
    expect(output).toContain("Default model");
    expect(output).toContain("Utility model");
    expect(output).toContain("<settings-api-keys-section");
    expect(output).not.toContain("<settings-nodes-section");
    expect(requests).toContain("/api/settings?key=default_model&key=utility_model");
    expect(requests).not.toContain("/api/nodes");
  });

  test("on mobile, the bare settings URL lists the sections without loading any", async () => {
    installViewport({ mobile: true });
    const requests = mockSettingsFetch();

    const output = fullOutput(await showPage(null));

    expect(output).toContain("Models");
    expect(output).toContain("Nodes");
    expect(output).toContain("The machines that run sessions");
    expect(output).not.toContain("<settings-api-keys-section");
    expect(output).not.toContain("<settings-nodes-section");
    expect(requests).toEqual([]);
  });

  test("on mobile, a section leads back to the section list", async () => {
    installViewport({ mobile: true });
    mockSettingsFetch();

    const output = fullOutput(await showPage("nodes"));

    expect(output).toContain("All settings");
    expect(output).toContain("<settings-nodes-section");
  });

  test("the Nodes section loads the nodes", async () => {
    installViewport({ mobile: false });
    const requests = mockSettingsFetch();

    const output = fullOutput(await showPage("nodes"));

    expect(output).toContain("<settings-nodes-section");
    expect(requests).toEqual(["/api/nodes"]);
  });

  test("shows the model settings once loaded while the model registry is still loading", async () => {
    installViewport({ mobile: false });
    const modelRegistry = deferred<Response>();
    mockSettingsFetch(modelRegistry.promise);

    const output = fullOutput(await showPage("models"));

    expect(output).toContain("Default model");
    expect(output).not.toContain("Loading settings...");

    modelRegistry.resolve(jsonResponse([]));
  });
});
