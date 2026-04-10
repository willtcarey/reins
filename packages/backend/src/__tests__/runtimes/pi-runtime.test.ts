import { describe, test, expect, mock } from "bun:test";
import { PiAgentRuntime, getPiSession } from "../../runtimes/pi/runtime.js";
import { createTestAgentSession } from "../helpers/test-pi.js";

describe("PiAgentRuntime", () => {
  test("delegates prompt, steer, abort, subscribe, getMessages, and close", async () => {
    const session = await createTestAgentSession();
    const unsubscribe = mock<() => void>(() => {});
    const prompt = mock<(text: string) => Promise<void>>(async () => {});
    const steer = mock<(text: string) => Promise<void>>(async () => {});
    const abort = mock<() => Promise<void>>(async () => {});
    const subscribe = mock<(listener: (event: any) => void) => () => void>(() => unsubscribe);
    const dispose = mock<() => void>(() => {});
    const messages = [{ role: "assistant", content: [{ type: "text", text: "hello" }] }];

    session.prompt = prompt;
    session.steer = steer;
    session.abort = abort;
    session.subscribe = subscribe;
    session.dispose = dispose;
    Object.defineProperty(session, "messages", {
      value: messages,
      configurable: true,
    });

    const runtime = new PiAgentRuntime(session);

    await runtime.prompt("hi");
    await runtime.steer("course-correct");
    await runtime.abort();

    const listener = mock<(event: any) => void>(() => {});
    const unsubscribeFn = runtime.subscribe(listener);
    unsubscribeFn();

    await expect(runtime.getMessages()).resolves.toEqual(messages);
    await runtime.close();

    expect(prompt).toHaveBeenCalledWith("hi");
    expect(steer).toHaveBeenCalledWith("course-correct");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(listener);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("exposes the wrapped pi session", async () => {
    const session = await createTestAgentSession();
    const runtime = new PiAgentRuntime(session);

    expect(getPiSession(runtime)).toBe(session);
  });
});
