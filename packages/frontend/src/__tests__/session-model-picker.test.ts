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

  function buildPicker(messageCount = 0) {
    const el = new SessionModelPicker();
    el.sessionId = "sess-1";
    el.sessionData = {
      id: "sess-1",
      projectId: 42,
      taskId: null,
      parentSessionId: null,
      name: null,
      createdAt: "",
      updatedAt: "",
      messageCount,
      runtimeType: "pi",
      activityState: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
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
    expect(getPrivate<string>(el, "_selectedRuntimeType")).toBe("pi");
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
            runtimeType: "pi",
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
    expect(await callPrivate<string>(el, "_currentLabel")).toBe("Claude Sonnet 4 · High");

    const output = templateToString(await callPrivate(el, "renderPopoverContent"));
    expect(output).toContain("Changes apply to this session only.");
    expect(output).not.toContain("Use global default");

    const values = collectTemplateValues(await callPrivate(el, "renderPopoverContent"));
    expect(values).toContain("anthropic");
    expect(values).toContain("claude-sonnet-4-20250514");
  });

  test("allows selecting models from any runtime before the first message", async () => {
    const el = buildPicker(0);
    callWillUpdate(el);

    mockFetch((url) => {
      if (url === "/api/models") {
        return jsonResponse([
          {
            runtimeType: "pi",
            provider: "anthropic",
            isAvailable: true,
            availabilitySource: "env",
            availabilitySources: ["env"],
            models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true }],
          },
          {
            runtimeType: "claude_agent_sdk",
            provider: "claude_agent_sdk",
            isAvailable: true,
            availabilitySource: "local",
            availabilitySources: ["local"],
            models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true }],
          },
        ]);
      }
      return jsonResponse({}, false);
    });

    await callPrivate(el, "_ensureLoaded");
    const providers = getPrivate<any[]>(el, "_pickerProviders");
    expect(providers).toHaveLength(2);
  });

  test("scopes model choices to the session runtime after messages exist", async () => {
    const el = buildPicker(1);
    callWillUpdate(el);

    mockFetch((url) => {
      if (url === "/api/models") {
        return jsonResponse([
          {
            runtimeType: "pi",
            provider: "anthropic",
            isAvailable: true,
            availabilitySource: "env",
            availabilitySources: ["env"],
            models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true }],
          },
          {
            runtimeType: "claude_agent_sdk",
            provider: "claude_agent_sdk",
            isAvailable: true,
            availabilitySource: "local",
            availabilitySources: ["local"],
            models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true }],
          },
        ]);
      }
      return jsonResponse({}, false);
    });

    await callPrivate(el, "_ensureLoaded");
    const providers = getPrivate<Array<{ runtimeType: string }>>(el, "_pickerProviders");
    expect(providers).toHaveLength(1);
    expect(providers[0]?.runtimeType).toBe("pi");
  });

  test("sends runtimeType when saving a model change", async () => {
    const el = buildPicker();
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
      let saved: unknown = null;
      el.updateSessionModel = async (update) => {
        saved = update;
        return { ok: true };
      };

      await callPrivate(el, "_saveModel", "claude_agent_sdk", "claude_agent_sdk", "claude-sonnet-4-20250514", "medium");

      expect(saved).toEqual({
        runtimeType: "claude_agent_sdk",
        provider: "claude_agent_sdk",
        modelId: "claude-sonnet-4-20250514",
        thinkingLevel: "medium",
      });
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
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

      await callPrivate(el, "_saveModel", "pi", "anthropic", "claude-sonnet-4-20250514", "medium");

      expect(getPrivate<string>(el, "_selectedThinking")).toBe("medium");
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  });
});
