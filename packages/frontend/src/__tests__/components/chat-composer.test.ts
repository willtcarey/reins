import { describe, expect, test } from "bun:test";
import {
  ChatComposer,
  buildClientPromptContent,
  findSkillTokenAt,
  imageMimeTypeForFile,
  focusTextareaWithoutScroll,
  blurTextarea,
  isAllowedImageFile,
} from "../../components/chat-composer.js";
import { templateToString } from "../helpers/lit-template.js";

describe("chat-composer helpers", () => {
  test("detects slash skill tokens at the caret", () => {
    expect(findSkillTokenAt("/dip run", 4)).toEqual({ start: 0, end: 4, query: "dip" });
    expect(findSkillTokenAt("please /tmux", 12)).toEqual({ start: 7, end: 12, query: "tmux" });
    expect(findSkillTokenAt("docker/dip", 10)).toBeNull();
  });

  test("keeps text-only submits as plain strings", () => {
    expect(buildClientPromptContent(" hello ", [])).toBe("hello");
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

  test("renders the attach control outside the prompt input box", () => {
    const el = new ChatComposer();

    const output = templateToString(el.render());
    const attachIndex = output.indexOf('data-role="attach-control"');
    const promptIndex = output.indexOf('data-role="prompt-box"');
    const promptBox = output.slice(promptIndex);

    expect(attachIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeGreaterThan(-1);
    expect(attachIndex).toBeLessThan(promptIndex);
    expect(promptBox).not.toContain('title="Attach image"');
  });

  test("renders the send control as an accessible icon button", () => {
    const el = new ChatComposer();

    const output = templateToString(el.render());

    expect(output).toContain('data-role="send-control"');
    expect(output).toContain('aria-label="Send message"');
    expect(output).toContain('data-role="send-icon"');
    expect(output).not.toContain(">Send</button>");
  });

  test("focuses the textarea with preventScroll when preserving keyboard focus", () => {
    const calls: unknown[] = [];
    const textarea = {
      focus: (options?: FocusOptions) => calls.push(options),
    };

    expect(focusTextareaWithoutScroll(textarea)).toBe(true);
    expect(calls).toEqual([{ preventScroll: true }]);
  });

  test("blurs the textarea to collapse the mobile keyboard", () => {
    let blurCalls = 0;
    const textarea = {
      blur: () => { blurCalls += 1; },
    };

    expect(blurTextarea(textarea)).toBe(true);
    expect(blurCalls).toBe(1);
    expect(blurTextarea(null)).toBe(false);
  });

  test("send control preserves keyboard focus during pointer and mouse activation", () => {
    const el = new ChatComposer();

    const output = templateToString(el.render());
    const sendStart = output.indexOf('data-role="send-control"');
    const sendEnd = output.indexOf(">", sendStart);
    const sendTag = output.slice(sendStart, sendEnd);

    expect(sendTag).toContain("@pointerdown=");
    expect(sendTag).toContain("@pointerup=");
    expect(sendTag).toContain("@mousedown=");
  });

  test("uses compact vertical spacing in the prompt input box", () => {
    const el = new ChatComposer();

    const output = templateToString(el.render());
    const promptStart = output.indexOf('data-role="prompt-box"');
    const textareaStart = output.indexOf("<textarea", promptStart);
    const textareaEnd = output.indexOf("</textarea>", textareaStart);
    const promptBoxOpenTag = output.slice(promptStart, textareaStart);
    const textareaTag = output.slice(textareaStart, textareaEnd);

    expect(promptBoxOpenTag).toContain("px-1 py-1 ");
    expect(promptBoxOpenTag).not.toContain("py-1.5");
    expect(textareaTag).toContain("px-1 py-1 ");
    expect(textareaTag).not.toContain("py-1.5");
  });
});
