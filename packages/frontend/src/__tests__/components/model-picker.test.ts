import { afterEach, describe, expect, test } from "bun:test";
import type { ModelSetting } from "@backend/settings-store.js";
import { ModelPicker } from "../../components/model-picker.js";
import { collectTemplateProperties, templateToString } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

const sonnet: ModelSetting = { runtimeType: "pi", provider: "anthropic", modelId: "claude-sonnet-4-20250514", thinkingLevel: "high" };

function registryResponse() {
  return new Response(JSON.stringify([{
    runtimeType: "pi",
    provider: "anthropic",
    isAvailable: true,
    availabilitySource: "env",
    availabilitySources: ["env"],
    models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true }],
  }]), { headers: { "Content-Type": "application/json" } });
}

function change(picker: ModelPicker, update: Partial<ModelSetting>): Promise<void> {
  return Reflect.apply(Reflect.get(picker, "change"), picker, [update]);
}

function shown(picker: ModelPicker): ModelSetting | null {
  return Reflect.get(picker, "shown");
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

/** A document for the error toast, in case no earlier test made the toast container. */
function stubToasts() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ add() {} }), body: { appendChild() {} } },
  });
}

afterEach(() => {
  restoreFetch();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

describe("ModelPicker", () => {
  test("shows nothing without a model", () => {
    expect(templateToString(new ModelPicker().render())).toBe("");
  });

  test("gives its anchor to the selector, and its caption to the panel", () => {
    const picker = new ModelPicker();
    picker.model = sonnet;
    picker.anchor = "left-end";
    picker.caption = "Changes apply to this session only.";

    const template = picker.render();
    const [content] = collectTemplateProperties(template, "content");

    expect(templateToString(template)).toContain("anchor=left-end");
    expect(typeof content === "function" ? templateToString(content()) : "").toContain("Changes apply to this session only.");
  });

  test("gives a changed thinking level to choose with the rest of the model", async () => {
    const chosen: ModelSetting[] = [];
    const picker = new ModelPicker();
    picker.model = sonnet;
    picker.choose = (model) => { chosen.push(model); };

    await change(picker, { thinkingLevel: "medium" });

    expect(chosen).toEqual([{ ...sonnet, thinkingLevel: "medium" }]);
  });

  test("shows the change while choose is pending, and its model again once it rejects", async () => {
    stubToasts();
    const choice = Promise.withResolvers<void>();
    const picker = new ModelPicker();
    picker.model = sonnet;
    picker.choose = () => choice.promise;

    const changing = change(picker, { thinkingLevel: "low" });
    expect(shown(picker)?.thinkingLevel).toBe("low");

    choice.reject(new Error("Failed to update session model: offline"));
    await changing;
    expect(shown(picker)).toEqual(sonnet);
  });

  test("finds the runtime of a model that has none from its provider", async () => {
    mockFetch(() => registryResponse());
    const picker = new ModelPicker();
    picker.model = { ...sonnet, runtimeType: "" };

    await Reflect.apply(Reflect.get(picker, "ensureLoaded"), picker, []);

    expect(shown(picker)?.runtimeType).toBe("pi");
  });
});
