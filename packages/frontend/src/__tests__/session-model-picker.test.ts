import { describe, expect, test, afterEach } from "bun:test";
import { type PropertyValues } from "lit";
import { SessionModelPicker } from "../components/session-model-picker.js";
import { collectTemplateValues, templateToString } from "./helpers/lit-template.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

function callWillUpdate(el: SessionModelPicker) {
  const changed: PropertyValues<SessionModelPicker> = new Map();
  changed.set("sessionData", null);
  el.willUpdate(changed);
}

function getPrivate<T>(obj: object, key: string): T {
  const value: T = Reflect.get(obj, key);
  return value;
}

function setPrivate(obj: object, key: string, value: unknown) {
  Reflect.set(obj, key, value);
}

async function callPrivate<T>(obj: object, key: string, ...args: unknown[]): Promise<T> {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") {
    throw new Error(`${key} is not callable`);
  }
  const result: T = await Reflect.apply(fn, obj, args);
  return result;
}

describe("SessionModelPicker", () => {
  afterEach(() => {
    restoreFetch();
  });

  function buildPicker() {
    const el = new SessionModelPicker();
    el.sessionId = "sess-1";
    el.sessionData = {
      id: "sess-1",
      task_id: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 0,
      },
    };
    return el;
  }

  test("anchors its popover upward from the composer area", () => {
    const el = buildPicker();

    const output = templateToString(el.render());

    expect(output).toContain('anchor="right-end"');
  });

  test("syncs the selected model from session data before rendering", () => {
    const el = buildPicker();

    callWillUpdate(el);

    expect(getPrivate<string>(el, "_selectedProvider")).toBe("anthropic");
    expect(getPrivate<string>(el, "_selectedModel")).toBe("claude-sonnet-4-20250514");
    expect(getPrivate<string>(el, "_selectedThinking")).toBe("high");
  });

  test("loads the model registry separately and keeps the current session selection bound in the picker", async () => {
    const el = buildPicker();
    callWillUpdate(el);
    const requests: string[] = [];

    mockFetch((url) => {
      requests.push(url);

      if (url === "/api/models") {
        return jsonResponse([
          {
            provider: "anthropic",
            isAvailable: true,
            availabilitySource: "env",
            availabilitySources: ["env"],
            models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true }],
          },
        ]);
      }

      return jsonResponse({}, false);
    });

    await callPrivate(el, "_ensureLoaded");

    expect(requests).toEqual(["/api/models"]);

    const registryStore = getPrivate<{ availableProviders: Array<{ provider: string }> }>(el, "_registryStore");
    expect(registryStore.availableProviders.map((provider) => provider.provider)).toEqual(["anthropic"]);
    expect(await callPrivate<string>(el, "_currentLabel")).toBe("Claude Sonnet 4");

    const output = templateToString(await callPrivate(el, "renderPopoverContent"));
    expect(output).toContain("Changes apply to this session only.");
    expect(output).not.toContain("Use global default");

    const values = collectTemplateValues(await callPrivate(el, "renderPopoverContent"));
    expect(values).toContain("anthropic");
    expect(values).toContain("claude-sonnet-4-20250514");
  });

  test("does not revert the selected thinking level to stale session data after save", async () => {
    const el = buildPicker();
    el.sessionData = {
      ...el.sessionData!,
      state: {
        ...el.sessionData!.state,
        thinkingLevel: "minimal",
      },
    };
    callWillUpdate(el);

    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => ({ add() {} }),
        body: { appendChild() {} },
      },
    });

    try {
      setPrivate(el, "_selectedThinking", "medium");
      el.updateSessionModel = async () => ({ ok: true });

      await callPrivate(el, "_saveModel", "anthropic", "claude-sonnet-4-20250514", "medium");

      expect(getPrivate<string>(el, "_selectedThinking")).toBe("medium");
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  });
});
