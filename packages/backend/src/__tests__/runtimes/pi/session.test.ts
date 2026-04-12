import { describe, expect, mock, test } from "bun:test";
import { createTestAgentSession } from "../../helpers/test-pi.js";
import { ephemeralPrompt } from "../../../runtimes/pi/session.js";

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
