import { describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { createTestAgentSession } from "../../helpers/test-pi.js";
import { useTestDb } from "../../helpers/test-db.js";
import { createServerState } from "../../helpers/server-state.js";
import { getPiSession } from "../../../runtimes/pi/runtime.js";
import { ephemeralPrompt, PiRuntimeAdapter } from "../../../runtimes/pi/session.js";

describe("PiRuntimeAdapter", () => {
  useTestDb();

  test("enables custom tools in the pi SDK allowlist", async () => {
    const customTool = defineTool({
      name: "create_task",
      label: "Create Task",
      description: "Create a task",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      }),
    });

    const adapter = new PiRuntimeAdapter();
    const runtime = await adapter.createRuntime({
      state: createServerState(),
      projectId: 1,
      projectDir: "/tmp",
      sessionId: "sess-pi-custom-tools",
      task: null,
      sessionTools: {
        builtins: ["read", "write", "edit", "bash"],
        customTools: [customTool],
      },
    });

    try {
      const session = getPiSession(runtime);
      const allToolNames = session.getAllTools().map((tool) => tool.name);

      expect(allToolNames).toContain("create_task");
      expect(session.getActiveToolNames()).toContain("create_task");
    } finally {
      await runtime.close();
    }
  });
});

describe("ephemeralPrompt", () => {
  test("aborts and returns empty string when prompt times out", async () => {
    const session = await createTestAgentSession();

    let releasePrompt: (() => void) | undefined;
    const prompt = mock(async (_text: string, _options?: { expandPromptTemplates?: boolean }) => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const abort = mock(async () => {
      releasePrompt?.();
    });

    session.prompt = prompt;
    session.abort = abort;

    const result = await ephemeralPrompt(session, { prompt: "hello", timeoutMs: 1 });

    expect(result).toBe("");
    expect(prompt).toHaveBeenCalledWith("hello", { expandPromptTemplates: false });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test("returns trimmed assistant text when prompt completes before timeout", async () => {
    const session = await createTestAgentSession();

    const prompt = mock(async (_text: string, _options?: { expandPromptTemplates?: boolean }) => {});
    const abort = mock(async () => {});

    session.prompt = prompt;
    session.abort = abort;
    session.getLastAssistantText = () => "  done  ";

    const result = await ephemeralPrompt(session, { prompt: "hello", timeoutMs: 1000 });

    expect(result).toBe("done");
    expect(abort).not.toHaveBeenCalled();
  });
});
