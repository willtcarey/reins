/**
 * Tests for error message filtering in session persistence.
 *
 * Empty assistant messages with stopReason: "error" should not be persisted
 * to avoid poisoning the conversation context.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import { loadMessages, persistMessages } from "../messages-store.js";
import { filterErrorMessages } from "../runtimes/pi/session.js";

let projectId: number;

describe("filterErrorMessages", () => {
  test("removes assistant messages with stopReason error and empty content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "overloaded_error",
        timestamp: 2000,
      },
    ];

    const filtered = filterErrorMessages(messages);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].role).toBe("user");
  });

  test("keeps assistant messages with stopReason error but non-empty content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial response" }],
        stopReason: "error",
        errorMessage: "connection reset",
        timestamp: 2000,
      },
    ];

    const filtered = filterErrorMessages(messages);
    expect(filtered).toHaveLength(2);
  });

  test("keeps normal assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
        stopReason: "stop",
        timestamp: 2000,
      },
    ];

    const filtered = filterErrorMessages(messages);
    expect(filtered).toHaveLength(2);
  });

  test("handles empty array", () => {
    expect(filterErrorMessages([])).toEqual([]);
  });

  test("removes trailing error message but keeps earlier valid messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "let me help" }],
        stopReason: "stop",
        timestamp: 1500,
      },
      { role: "user", content: [{ type: "text", text: "another question" }], timestamp: 2000 },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "overloaded_error",
        timestamp: 2500,
      },
    ];

    const filtered = filterErrorMessages(messages);
    expect(filtered).toHaveLength(3);
    expect(filtered[2].role).toBe("user");
  });
});

describe("persistMessages — error filtering integration", () => {
  useTestDb();

  beforeEach(() => {
    const project = createProject("Test Project", "/tmp/test-project");
    projectId = project.id;
  });

  test("does not persist empty error assistant messages", () => {
    createSession("sess-err", projectId, { agentRuntimeType: "pi" });

    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "overloaded_error",
        timestamp: 2000,
      },
    ];

    persistMessages("sess-err", filterErrorMessages(messages));

    const loaded = loadMessages("sess-err");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].role).toBe("user");
  });

  test("preserves valid messages when error messages are filtered", () => {
    createSession("sess-err2", projectId, { agentRuntimeType: "pi" });

    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
        timestamp: 1500,
      },
      { role: "user", content: [{ type: "text", text: "more" }], timestamp: 2000 },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "server error",
        timestamp: 2500,
      },
    ];

    persistMessages("sess-err2", filterErrorMessages(messages));

    const loaded = loadMessages("sess-err2");
    expect(loaded).toHaveLength(3);
    expect(loaded[0].role).toBe("user");
    expect(loaded[1].role).toBe("assistant");
    expect(loaded[2].role).toBe("user");
  });
});
