import { describe, expect, mock, test } from "bun:test";
import {
  ChatComposer,
  buildClientPromptContent,
  dataTransferHasFiles,
  filesFromDataTransfer,
  findSlashTokenAt,
  imageMimeTypeForFile,
  isAllowedImageFile,
  type DraftAttachment,
} from "../../components/chat-composer.js";
import type { ChatComposerSubmitDetail } from "../../components/events.js";
import { templateToString } from "../helpers/lit-template.js";
import type { Command, CommandContext } from "@reins/sdk";
import { CommandRegistry } from "../../sdk-host/commands.js";
function callPrivate<T = unknown>(obj: object, key: string, ...args: unknown[]): T {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  const result: T = Reflect.apply(fn, obj, args);
  return result;
}

describe("chat-composer helpers", () => {
  test("detects slash tokens at the caret", () => {
    expect(findSlashTokenAt("/dip run", 4)).toEqual({ start: 0, end: 4, query: "dip" });
    expect(findSlashTokenAt("please /tmux", 12)).toEqual({ start: 7, end: 12, query: "tmux" });
    expect(findSlashTokenAt("docker/dip", 10)).toBeNull();
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

  test("extracts dropped files when browsers expose them through DataTransfer items", () => {
    const image = new File(["png bytes"], "screen.png", { type: "image/png" });

    expect(filesFromDataTransfer({
      files: [],
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => image },
      ],
    })).toEqual([image]);
  });

  test("recognizes file drags from DataTransfer types before file contents are readable", () => {
    expect(dataTransferHasFiles({
      files: [],
      types: { contains: (value: string) => value === "Files" },
    })).toBe(true);
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

  test("adds draft attachments without requiring crypto.randomUUID", () => {
    const randomUUIDDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
    const el = new ChatComposer();

    try {
      el.addAttachmentFiles([new File(["png bytes"], "screen.png", { type: "image/png" })]);

      const attachments: DraftAttachment[] = Reflect.get(el, "draftAttachments");
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        filename: "screen.png",
        mimeType: "image/png",
      });
      expect(attachments[0]?.id).toStartWith("draft-att-");
    } finally {
      callPrivate(el, "clearDraft");
      if (randomUUIDDescriptor) {
        Object.defineProperty(globalThis.crypto, "randomUUID", randomUUIDDescriptor);
      } else {
        Reflect.deleteProperty(globalThis.crypto, "randomUUID");
      }
    }
  });

  test("adds pasted image files from clipboard items when the files list is empty", () => {
    const el = new ChatComposer();
    const preventDefault = mock(() => undefined);
    const image = new File(["png bytes"], "pasted.png", { type: "image/png" });

    try {
      callPrivate(el, "handlePaste", {
        clipboardData: {
          files: [],
          items: [
            { kind: "string", getAsFile: () => null },
            { kind: "file", getAsFile: () => image },
          ],
        },
        preventDefault,
      });

      const attachments: DraftAttachment[] = Reflect.get(el, "draftAttachments");
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        filename: "pasted.png",
        mimeType: "image/png",
      });
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

    const uploadAttachments = mock(async (attachments: readonly DraftAttachment[]) => {
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        filename: "screen.png",
        mimeType: "image/png",
        byteSize: 9,
      });
      return [{
        id: "att_1",
        kind: "image" as const,
        mimeType: "image/png",
        filename: "screen.png",
        byteSize: 9,
        sha256: "abc",
        url: "/api/sessions/sess-1/attachments/att_1",
        width: 640,
        height: 480,
      }];
    });
    el.uploadAttachments = uploadAttachments;

    await callPrivate<Promise<void>>(el, "handleSend");

    expect(uploadAttachments).toHaveBeenCalledTimes(1);
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

  test("shows the placeholder it is given", () => {
    const el = new ChatComposer();
    el.placeholder = "Describe the work";

    expect(templateToString(el.render())).toContain("placeholder=Describe the work");
  });

  test("sends nothing while it is disabled", async () => {
    const el = new ChatComposer();
    el.disabled = true;
    Reflect.set(el, "inputText", "hello");
    let dispatched = 0;
    Object.defineProperty(el, "dispatchEvent", { configurable: true, value: () => { dispatched += 1; return true; } });

    await callPrivate<Promise<void>>(el, "handleSend");

    expect(dispatched).toBe(0);
    expect(Reflect.get(el, "inputText")).toBe("hello");
  });

  test("gives the message to its submit function in place of the event, clearing the text once it resolves", async () => {
    const el = new ChatComposer();
    const submitted: unknown[] = [];
    el.submit = async ({ content }) => { submitted.push(content); };
    Reflect.set(el, "inputText", "hello");
    Object.defineProperty(el, "dispatchEvent", { configurable: true, value: () => { throw new Error("Expected no event"); } });

    await callPrivate<Promise<void>>(el, "handleSend");

    expect(submitted).toEqual([[{ type: "text", text: "hello" }]]);
    expect(Reflect.get(el, "inputText")).toBe("");
  });

  test("keeps the text and the attachments, and shows the error, when its submit function rejects", async () => {
    const el = new ChatComposer();
    el.submit = () => Promise.reject(new Error("Task 3 is not a task of this project"));
    el.uploadAttachments = async () => [];
    Reflect.set(el, "inputText", "hello");
    const attachment = { id: "draft-1", file: new File(["x"], "a.png", { type: "image/png" }), objectUrl: "", byteSize: 1, mimeType: "image/png", filename: "a.png" };
    Reflect.set(el, "draftAttachments", [attachment]);

    await callPrivate<Promise<void>>(el, "handleSend");

    expect(Reflect.get(el, "inputText")).toBe("hello");
    expect(Reflect.get(el, "draftAttachments")).toEqual([attachment]);
    expect(Reflect.get(el, "errorMessage")).toBe("Task 3 is not a task of this project");
    expect(Reflect.get(el, "isUploading")).toBe(false);
  });

  test("lets unexpected submit failures bubble instead of becoming composer errors", async () => {
    const el = new ChatComposer();
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

describe("ChatComposer commands", () => {
  /** A composer with `commands` registered, and the events it dispatched. */
  function composerWith(commands: Command[]) {
    const registry = new CommandRegistry();
    for (const command of commands) registry.register(command);
    const el = new ChatComposer();
    el.commands = registry;
    const dispatched: string[] = [];
    Object.defineProperty(el, "dispatchEvent", {
      configurable: true,
      value: (event: Event) => {
        if (!(event instanceof CustomEvent)) throw new Error("Expected CustomEvent");
        const detail: ChatComposerSubmitDetail = event.detail;
        dispatched.push(JSON.stringify(detail.content));
        return true;
      },
    });
    return { el, dispatched };
  }

  test("runs a command that starts the message instead of sending it, then clears the text", async () => {
    const runs: CommandContext[] = [];
    const { el, dispatched } = composerWith([{ name: "compact", description: "Compact", run: (context) => { runs.push(context); } }]);
    Reflect.set(el, "inputText", "/compact keep the API names");

    await callPrivate<Promise<void>>(el, "handleSend");

    expect(runs).toEqual([{ args: "keep the API names" }]);
    expect(dispatched).toEqual([]);
    expect(Reflect.get(el, "inputText")).toBe("");
    expect(Reflect.get(el, "errorMessage")).toBe("");
  });

  test("keeps the text and shows the error when a command fails", async () => {
    const { el } = composerWith([{ name: "compact", description: "Compact", run: () => Promise.reject(new Error("There is nothing to compact yet")) }]);
    Reflect.set(el, "inputText", "/compact");

    await callPrivate<Promise<void>>(el, "handleSend");

    expect(Reflect.get(el, "inputText")).toBe("/compact");
    expect(Reflect.get(el, "errorMessage")).toBe("There is nothing to compact yet");
  });

  test("sends a slash word no command has, and a command's name later in a message, as text", async () => {
    let ran = false;
    const { el, dispatched } = composerWith([{ name: "compact", description: "Compact", run: () => { ran = true; } }]);

    Reflect.set(el, "inputText", "/dip start the server");
    await callPrivate<Promise<void>>(el, "handleSend");
    Reflect.set(el, "inputText", "please /compact");
    await callPrivate<Promise<void>>(el, "handleSend");

    expect(ran).toBe(false);
    expect(dispatched).toEqual([
      JSON.stringify([{ type: "text", text: "/dip start the server" }]),
      JSON.stringify([{ type: "text", text: "please /compact" }]),
    ]);
  });
});
