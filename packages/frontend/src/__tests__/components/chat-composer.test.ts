import { describe, expect, mock, test } from "bun:test";
import {
  ChatComposer,
  buildClientPromptContent,
  findSkillTokenAt,
  imageMimeTypeForFile,
  isAllowedImageFile,
  type ChatComposerSubmitDetail,
  type DraftAttachment,
} from "../../components/chat-composer.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

function callPrivate<T = unknown>(obj: object, key: string, ...args: unknown[]): T {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  const result: T = Reflect.apply(fn, obj, args);
  return result;
}

describe("chat-composer helpers", () => {
  test("detects slash skill tokens at the caret", () => {
    expect(findSkillTokenAt("/dip run", 4)).toEqual({ start: 0, end: 4, query: "dip" });
    expect(findSkillTokenAt("please /tmux", 12)).toEqual({ start: 7, end: 12, query: "tmux" });
    expect(findSkillTokenAt("docker/dip", 10)).toBeNull();
  });

  test("keeps text-only submits as content blocks", () => {
    expect(buildClientPromptContent(" hello ", [])).toEqual([{ type: "text", text: "hello" }]);
  });

  test("builds multimodal content from text plus attachment refs", () => {
    const content = buildClientPromptContent(" look ", [
      {
        id: "att_1",
        kind: "image",
        mimeType: "image/png",
        filename: "screen.png",
        byteSize: 123,
        sha256: "abc",
        url: "/api/sessions/s1/attachments/att_1",
        width: 640,
        height: 480,
      },
    ]);

    expect(content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        attachmentId: "att_1",
        mimeType: "image/png",
        filename: "screen.png",
        byteSize: 123,
        sha256: "abc",
        width: 640,
        height: 480,
      },
    ]);
  });

  test("recognizes supported image file types", () => {
    expect(isAllowedImageFile(new File(["x"], "x.png", { type: "image/png" }))).toBe(true);
    expect(isAllowedImageFile(new File(["x"], "x.txt", { type: "text/plain" }))).toBe(false);
  });

  test("falls back to image extensions when browsers omit file MIME types", () => {
    const screenshot = new File(["x"], "Screenshot.PNG");

    expect(isAllowedImageFile(screenshot)).toBe(true);
    expect(imageMimeTypeForFile(screenshot)).toBe("image/png");
  });
});

describe("ChatComposer behavior", () => {
  test("autosizes the textarea using scroll height and caps tall drafts", () => {
    const el = new ChatComposer();
    const style: Record<string, string> = {};
    const textarea = {
      scrollHeight: 84,
      style,
    };
    Object.defineProperty(el, "textarea", { configurable: true, value: textarea });

    callPrivate(el, "syncTextareaHeight");
    expect(textarea.style.height).toBe("84px");
    expect(textarea.style.overflowY).toBe("hidden");

    textarea.scrollHeight = 240;
    callPrivate(el, "syncTextareaHeight");
    expect(textarea.style.height).toBe("200px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  test("adds pasted image files as draft attachments", () => {
    const el = new ChatComposer();
    const preventDefault = mock(() => undefined);

    try {
      callPrivate(el, "handlePaste", {
        clipboardData: {
          files: [
            new File(["png bytes"], "screen.png", { type: "image/png" }),
            new File(["not an image"], "note.txt", { type: "text/plain" }),
          ],
        },
        preventDefault,
      });

      const attachments: DraftAttachment[] = Reflect.get(el, "draftAttachments");
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        filename: "screen.png",
        mimeType: "image/png",
        byteSize: "png bytes".length,
      });
      expect(attachments[0]?.objectUrl.startsWith("blob:")).toBe(true);
    } finally {
      callPrivate(el, "clearDraft");
    }
  });

  test("lets object URL creation failures propagate", () => {
    const originalCreate = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: mock(() => { throw new Error("object url failed"); }),
    });
    try {
      const el = new ChatComposer();

      expect(() => callPrivate(el, "handlePaste", {
        clipboardData: { files: [new File(["x"], "screen.png", { type: "image/png" })] },
        preventDefault: mock(() => undefined),
      })).toThrow("object url failed");
      expect(Reflect.get(el, "draftAttachments")).toEqual([]);
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
    }
  });

  test("uploads draft attachments and dispatches a multimodal submit", async () => {
    const el = new ChatComposer();
    el.sessionId = "sess-1";
    Reflect.set(el, "inputText", " look ");
    Reflect.set(el, "draftAttachments", [
      {
        id: "draft-1",
        file: new File(["png bytes"], "screen.png", { type: "image/png" }),
        objectUrl: "",
        byteSize: "png bytes".length,
        mimeType: "image/png",
        filename: "screen.png",
      } satisfies DraftAttachment,
    ]);

    const dispatched: CustomEvent<ChatComposerSubmitDetail>[] = [];
    Object.defineProperty(el, "dispatchEvent", {
      configurable: true,
      value: (event: Event) => {
        if (!(event instanceof CustomEvent)) throw new Error("Expected CustomEvent");
        const submitted: CustomEvent<ChatComposerSubmitDetail> = event;
        dispatched.push(submitted);
        return true;
      },
    });

    let fetchCount = 0;
    const uploadState: { form: FormData | null } = { form: null };
    mockFetch((url, init) => {
      fetchCount += 1;
      expect(url).toBe("/api/sessions/sess-1/attachments");
      expect(init?.method).toBe("POST");
      if (!(init?.body instanceof FormData)) throw new Error("Expected FormData upload body");
      uploadState.form = init.body;
      return new Response(JSON.stringify({
        attachments: [{
          id: "att_1",
          kind: "image",
          mimeType: "image/png",
          filename: "screen.png",
          byteSize: 9,
          sha256: "abc",
          url: "/api/sessions/sess-1/attachments/att_1",
          width: 640,
          height: 480,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    try {
      await callPrivate<Promise<void>>(el, "handleSend");
    } finally {
      restoreFetch();
    }

    expect(fetchCount).toBe(1);
    if (!uploadState.form) throw new Error("Expected upload form");
    const form: FormData = uploadState.form;
    expect(form.getAll("files")).toHaveLength(1);
    expect(form.get("metadata")).toBeNull();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("composer-submit");
    expect(dispatched[0].bubbles).toBe(true);
    expect(dispatched[0].composed).toBe(true);
    expect(dispatched[0].detail.content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        attachmentId: "att_1",
        mimeType: "image/png",
        filename: "screen.png",
        byteSize: 9,
        sha256: "abc",
        width: 640,
        height: 480,
      },
    ]);
    expect(Reflect.get(el, "inputText")).toBe("");
    expect(Reflect.get(el, "draftAttachments")).toEqual([]);
  });

  test("lets unexpected submit failures bubble instead of becoming composer errors", async () => {
    const el = new ChatComposer();
    el.sessionId = "sess-1";
    Reflect.set(el, "inputText", "hello");
    Object.defineProperty(el, "dispatchEvent", {
      configurable: true,
      value: () => { throw new Error("submit listener failed"); },
    });

    let thrown: unknown;
    try {
      await callPrivate<Promise<void>>(el, "handleSend");
    } catch (err) {
      thrown = err;
    }

    if (!(thrown instanceof Error)) throw new Error("Expected submit failure to throw");
    expect(thrown.message).toBe("submit listener failed");
    expect(Reflect.get(el, "errorMessage")).toBe("");
    expect(Reflect.get(el, "isUploading")).toBe(false);
  });
});
