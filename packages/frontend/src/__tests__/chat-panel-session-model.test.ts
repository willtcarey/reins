import { describe, expect, test } from "bun:test";
import { ChatPanel } from "../components/chat-panel.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { templateToString } from "./helpers/lit-template.js";

describe("ChatPanel session model affordance", () => {
  test("renders a session model button when session data is present", () => {
    const store = new ActiveSessionStore();
    store.sessionId = "sess-1";
    store.sessionData = {
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
        isStreaming: false,
        messageCount: 0,
      },
    };

    const el = new ChatPanel();
    el.store = store;

    const output = templateToString(el.render());

    expect(output).toContain("session-model-picker");
    expect(output).toContain(".sessionId=sess-1");
  });
});
