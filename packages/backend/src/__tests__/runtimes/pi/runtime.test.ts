import { describe, test, expect, mock } from "bun:test";
import { PiAgentRuntime, getPiSession } from "../../../runtimes/pi/runtime.js";
import { createProject } from "../../../project-store.js";
import { createSession } from "../../../session-store.js";
import { storeSessionAttachment } from "../../../session-attachments-store.js";
import { createTestAgentSession } from "../../helpers/test-pi.js";
import { useTestDb } from "../../helpers/test-db.js";

describe("PiAgentRuntime", () => {
  useTestDb();

  test("delegates prompt, steer, abort, subscribe, getMessages, and close", async () => {
    const session = await createTestAgentSession();
    const unsubscribe = mock<() => void>(() => {});
    const prompt = mock<(text: string) => Promise<void>>(async () => {});
    const steer = mock<(text: string) => Promise<void>>(async () => {});
    const abort = mock<() => Promise<void>>(async () => {});
    const subscribe = mock<(listener: (event: any) => void) => () => void>(() => unsubscribe);
    const dispose = mock<() => void>(() => {});
    const messages = [{ role: "assistant", content: [{ type: "text" as const, text: "hello" }] }];

    session.prompt = prompt;
    session.steer = steer;
    session.abort = abort;
    session.subscribe = subscribe;
    session.dispose = dispose;
    Object.defineProperty(session, "messages", {
      value: messages,
      configurable: true,
    });

    const runtime = new PiAgentRuntime(session, "sess-pi-runtime");

    await runtime.prompt([{ type: "text", text: "hi" }]);
    await runtime.steer([{ type: "text", text: "course-correct" }]);
    await runtime.abort();

    const listener = mock<(event: any) => void>(() => {});
    const unsubscribeFn = runtime.subscribe(listener);
    unsubscribeFn();

    await expect(runtime.getMessages()).resolves.toEqual(messages);
    await runtime.close();

    expect(prompt).toHaveBeenCalledWith("hi");
    expect(steer).toHaveBeenCalledWith("course-correct");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("normalizes pi string messages to Reins block-only messages", async () => {
    const session = await createTestAgentSession();
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "compactionSummary", content: "summarized context" },
    ];
    Object.defineProperty(session, "messages", {
      value: messages,
      configurable: true,
    });

    const runtime = new PiAgentRuntime(session, "sess-pi-runtime");

    await expect(runtime.getMessages()).resolves.toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "compactionSummary", summary: "summarized context" },
    ]);
  });

  test("hydrates attachment refs before calling pi", async () => {
    const project = createProject("Pi Runtime Images", "/tmp/pi-runtime-images");
    createSession("sess-pi-images", project.id, { agentRuntimeType: "pi" });
    const imageData = Buffer.from("pi prompt image");
    const attachment = storeSessionAttachment("sess-pi-images", {
      data: imageData,
      mimeType: "image/png",
      filename: "prompt.png",
      width: 320,
      height: 200,
    });

    const session = await createTestAgentSession();
    const prompt = mock(async (_text: string, _options?: { images?: unknown[] }) => {});
    session.prompt = prompt;

    const runtime = new PiAgentRuntime(session, "sess-pi-images");

    await runtime.prompt([
      { type: "text", text: "describe" },
      {
        type: "image",
        attachmentId: attachment.id,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        byteSize: attachment.byteSize,
        sha256: attachment.sha256,
        width: attachment.width,
        height: attachment.height,
      },
    ]);

    expect(prompt).toHaveBeenCalledWith("describe", {
      images: [{
        type: "image",
        data: imageData.toString("base64"),
        mimeType: "image/png",
        filename: "prompt.png",
        width: 320,
        height: 200,
      }],
    });
  });

  test("forwards pi compaction events to listeners", async () => {
    const session = await createTestAgentSession();
    let capturedListener: ((event: any) => void) | undefined;
    const subscribe = mock<(listener: (event: any) => void) => () => void>((candidate) => {
      capturedListener = candidate;
      return () => {};
    });
    session.subscribe = subscribe;

    const runtime = new PiAgentRuntime(session, "sess-pi-runtime");
    const listener = mock<(event: any) => void>(() => {});
    runtime.subscribe(listener);

    expect(capturedListener).toBeDefined();
    const emit = capturedListener!;

    emit({ type: "compaction_start", reason: "threshold" });
    emit({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "done" },
      aborted: false,
      willRetry: false,
    });

    expect(listener.mock.calls).toEqual([
      [{ type: "compaction_start", reason: "threshold" }],
      [{ type: "compaction_end", reason: "threshold", result: { summary: "done" }, aborted: false, willRetry: false }],
    ]);
  });

  test("exposes the wrapped pi session", async () => {
    const session = await createTestAgentSession();
    const runtime = new PiAgentRuntime(session, "sess-pi-runtime");

    expect(getPiSession(runtime)).toBe(session);
  });
});
