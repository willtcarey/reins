import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAiImagesApi } from "@backend/extensions/openai-images/api.js";
import { SettingsOpenAiImagesSection } from "../../../extensions/openai-images/endpoints-section.js";
import { EndpointsStore, type EndpointView } from "../../../extensions/openai-images/endpoints-store.js";
import { registerOpenAiImages } from "../../../extensions/openai-images/index.js";
import { Loadable } from "../../../helpers/loadable.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";
import { testElement } from "../../helpers/test-dom.js";
import { clickButton, collectTemplateProperties, submitDialog, templateToString, typeIntoField } from "../../helpers/lit-template.js";
import { setConfirmHostForTesting } from "../../../ui/confirm-dialog.js";

const originalHtmlInputElement = globalThis.HTMLInputElement;
const originalHtmlTextAreaElement = globalThis.HTMLTextAreaElement;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

class TestInputElement extends EventTarget {
  value = "";
}

afterEach(() => {
  restoreFetch();
  setConfirmHostForTesting(null);
  Reflect.set(globalThis, "HTMLInputElement", originalHtmlInputElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", originalHtmlTextAreaElement);
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

/** A document for the error toast, in case no earlier test made the toast container. */
function stubToasts() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ add() {} }), body: { appendChild() {} } },
  });
}

function endpoint(overrides: Partial<EndpointView> = {}): EndpointView {
  return {
    id: 1, name: "william-pc", baseUrl: "http://william-pc:30010/v1", hasApiKey: false, models: null,
    defaultParameters: { output_format: "png" }, randomSeed: false, createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z",
    ...overrides,
  };
}

const visibleText = (rendered: unknown) => templateToString(rendered).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** The section with each endpoint's menu open: its items are rendered only then. */
function withMenus(section: SettingsOpenAiImagesSection): unknown[] {
  const rendered = section.render();
  return [rendered, ...collectTemplateProperties(rendered, "content").map(content => typeof content === "function" ? content() : null)];
}

const EXTENSION = { name: "openai-images", label: "OpenAI images" };

function sectionListing(endpoints: EndpointView[], sdk = testSdk<OpenAiImagesApi>({ extension: EXTENSION })): SettingsOpenAiImagesSection {
  const store = new EndpointsStore(sdk.reins);
  store.endpoints = Loadable.idle<EndpointView[]>().asLoaded(endpoints);
  const section = new SettingsOpenAiImagesSection();
  section.store = store;
  return section;
}

function recordRequests(respond: (url: string) => Response | Promise<Response>): Array<{ request: string; body: unknown }> {
  const requests: Array<{ request: string; body: unknown }> = [];
  mockFetch((url, init) => {
    requests.push({ request: `${init?.method ?? "GET"} ${url}`, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return respond(url);
  });
  return requests;
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i++) await Bun.sleep(1);
}

describe("SettingsOpenAiImagesSection", () => {
  test("shows each endpoint's URL, models, default parameters and random seed", () => {
    expect(visibleText(sectionListing([endpoint()]).render())).toContain(
      "william-pc http://william-pc:30010/v1 Models: every model the server lists Default parameters: {\"output_format\":\"png\"}",
    );
    expect(visibleText(sectionListing([endpoint({ hasApiKey: true, models: ["a", "b"], defaultParameters: {} })]).render())).toContain(
      "william-pc API key http://william-pc:30010/v1 Models: a, b Add image endpoint",
    );
    expect(visibleText(sectionListing([endpoint({ randomSeed: true })]).render())).toContain(
      "Default parameters: {\"output_format\":\"png\"} Random seed for each request",
    );
    expect(visibleText(sectionListing([]).render())).toContain("No image endpoints yet.");
  });

  test("adding an endpoint sends its fields, the models one a line and the default parameters as JSON, and lists it", async () => {
    Reflect.set(globalThis, "HTMLInputElement", TestInputElement);
    Reflect.set(globalThis, "HTMLTextAreaElement", TestInputElement);
    const created = endpoint({ id: 2, name: "openai", hasApiKey: true });
    const requests = recordRequests(() => Response.json(created));
    const section = sectionListing([endpoint()]);

    clickButton(section.render(), "Add image endpoint");
    typeIntoField(section.render(), "Name", "openai", new TestInputElement());
    typeIntoField(section.render(), "Base URL", "https://api.openai.com/v1", new TestInputElement());
    typeIntoField(section.render(), "API key", "sk-1", new TestInputElement());
    typeIntoField(section.render(), "Models", "gpt-image-1\n dall-e-3 \n", new TestInputElement());
    typeIntoField(section.render(), "Default parameters", "{ \"quality\": \"low\" }", new TestInputElement());
    clickButton(section.render(), "Random seed");
    submitDialog(section.render());

    await until(() => section.store!.endpoints.data!.length === 2);
    expect(requests).toEqual([{
      request: "POST /api/extensions/openai-images/add",
      body: { name: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-1", models: ["gpt-image-1", "dall-e-3"], defaultParameters: { quality: "low" }, randomSeed: true },
    }]);
    expect(section.store!.endpoints.data!.map(listed => listed.name)).toEqual(["openai", "william-pc"]);
  });

  test("default parameters that are not a JSON object are refused before anything is sent", async () => {
    stubToasts();
    Reflect.set(globalThis, "HTMLTextAreaElement", TestInputElement);
    const requests = recordRequests(() => Response.json(endpoint()));
    const section = sectionListing([endpoint()]);

    clickButton(withMenus(section), "Edit");
    typeIntoField(section.render(), "Default parameters", "[1]", new TestInputElement());
    submitDialog(section.render());
    await Bun.sleep(1);

    expect(requests).toEqual([]);
    expect(templateToString(section.render())).toContain("heading=Edit william-pc");
  });

  test("editing leaves the API key out unless one is typed, and blank models mean every model", async () => {
    Reflect.set(globalThis, "HTMLTextAreaElement", TestInputElement);
    const requests = recordRequests(() => Response.json(endpoint({ hasApiKey: true })));
    const section = sectionListing([endpoint({ hasApiKey: true, models: ["m"] })]);

    clickButton(withMenus(section), "Edit");
    expect(templateToString(section.render())).toContain("Saved (leave blank to keep it)");
    typeIntoField(section.render(), "Models", "  ", new TestInputElement());
    submitDialog(section.render());

    await until(() => requests.length === 1);
    expect(requests).toEqual([{
      request: "POST /api/extensions/openai-images/update",
      body: { id: 1, changes: { name: "william-pc", baseUrl: "http://william-pc:30010/v1", models: null, defaultParameters: { output_format: "png" }, randomSeed: false } },
    }]);
  });

  test("Test shows the models the server lists, or why it failed", async () => {
    let answer = Response.json({ models: ["Qwen-Image-2.1-Turbo"] });
    const requests = recordRequests(() => answer);
    const section = sectionListing([endpoint()]);

    clickButton(withMenus(section), "Test");
    await until(() => visibleText(section.render()).includes("The server lists"));
    expect(visibleText(section.render())).toContain("The server lists Qwen-Image-2.1-Turbo.");

    answer = Response.json({ error: "william-pc: Unable to connect" }, { status: 502 });
    clickButton(withMenus(section), "Test");
    await until(() => visibleText(section.render()).includes("Unable to connect"));
    expect(visibleText(section.render())).not.toContain("The server lists");
    expect(requests.map(request => request.body)).toEqual([{ id: 1 }, { id: 1 }]);
  });

  test("Remove asks first; confirming removes the endpoint", async () => {
    const requests = recordRequests(() => new Response(null, { status: 204 }));
    const asked: string[] = [];
    setConfirmHostForTesting({ open: async (options) => { asked.push(options.title); return true; } });
    const section = sectionListing([endpoint()]);

    clickButton(withMenus(section), "Remove");
    await until(() => section.store!.endpoints.data!.length === 0);

    expect(asked).toEqual(["Remove william-pc?"]);
    expect(requests).toEqual([{ request: "POST /api/extensions/openai-images/remove", body: { id: 1 } }]);
  });
});

describe("registerOpenAiImages", () => {
  test("gives the extension a Settings page, which lists the endpoints once shown", async () => {
    const requests = recordRequests(() => Response.json([endpoint()]));
    const { reins, settingsPages } = testSdk<OpenAiImagesApi>({ extension: EXTENSION });
    const dispose = registerOpenAiImages(reins);
    const target = testElement();

    const mounted = settingsPages.page("openai-images")?.settings.mount(target);
    const [shown] = target.childNodes;

    expect(shown).toBeInstanceOf(SettingsOpenAiImagesSection);
    if (!(shown instanceof SettingsOpenAiImagesSection)) return;
    await until(() => shown.store?.endpoints.data?.length === 1);
    expect(requests.map(request => request.request)).toEqual(["POST /api/extensions/openai-images/list"]);
    mounted?.dispose?.();
    dispose();
    expect(settingsPages.page("openai-images")).toBeNull();
  });
});
