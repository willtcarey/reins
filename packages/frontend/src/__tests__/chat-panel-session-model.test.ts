import { describe, expect, test } from "bun:test";
import { ChatPanel } from "../components/chat-panel.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { SessionCache } from "../models/stores/session-cache.js";
import { templateToString } from "./helpers/lit-template.js";

describe("ChatPanel session model affordance", () => {
  test("renders a session model button when session data is present", () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    const sessionData = {
      id: "sess-1",
      projectId: 42,
      taskId: null,
      parentSessionId: null,
      name: null,
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      activityState: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        messageCount: 0,
      },
    };
    sessionCache.set("sess-1", sessionData);

    const el = new ChatPanel();
    el.store = store;

    const output = templateToString(el.render());

    expect(output).toContain("session-model-picker");
    expect(output).toContain(".sessionId=sess-1");
  });
});
