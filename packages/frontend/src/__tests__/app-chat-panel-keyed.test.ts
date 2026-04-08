import { afterEach, describe, expect, test } from "bun:test";
import { AppShell } from "../components/app.js";
import { collectTemplateValues, templateToString } from "./helpers/lit-template.js";

const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

afterEach(() => {
  Reflect.set(globalThis, "location", originalLocation);
  Reflect.set(globalThis, "window", originalWindow);
  Reflect.set(globalThis, "navigator", originalNavigator);
});

describe("AppShell chat panel rendering", () => {
  test("keys chat-panel by sessionId so it remounts on session switches", () => {
    Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
    Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: false }) });
    Reflect.set(globalThis, "navigator", { standalone: false });

    const el = new AppShell();

    const activeSessionStore = {
      sessionId: "sess-1",
      sessionData: {
        id: "sess-1",
        task_id: null,
        state: {
          model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
          thinkingLevel: "high",
          isStreaming: false,
          messageCount: 0,
        },
      },
      sessionMessages: [],
    };

    Reflect.set(el, "appStore", {
      connected: true,
      projectId: 42,
      sessionId: "sess-1",
      activeSessionStore,
      diffStore: {
        branch: null,
        fileData: { branch: "main" },
      },
    });

    const output = el.render();
    const values = collectTemplateValues(output);
    const keyedChatPanel = values.find((value) => {
      if (!value || typeof value !== "object" || !("values" in value)) return false;
      const directiveValues = Reflect.get(value, "values");
      return Array.isArray(directiveValues) && directiveValues[0] === "sess-1";
    });

    expect(keyedChatPanel).toBeDefined();

    const chatPanelTemplate = Reflect.get(keyedChatPanel!, "values")[1];
    expect(templateToString(chatPanelTemplate)).toContain("<chat-panel");
    expect(collectTemplateValues(chatPanelTemplate)).toContain(activeSessionStore);
  });
});
