import { describe, expect, test } from "bun:test";
import { ChatPanel } from "../../components/chat-panel.js";
import { templateToString } from "../helpers/lit-template.js";

describe("chat-panel attachment rendering", () => {
  test("renders user image attachments above text as size-preserving viewer buttons", () => {
    const el = new ChatPanel();
    Reflect.set(el, "store", { sessionId: "sess-attachments" });
    Reflect.set(el, "messages", [
      {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "what do you see?" },
          {
            type: "image",
            attachmentId: "att_1",
            mimeType: "image/png",
            filename: "screen.png",
            byteSize: 123,
            width: 640,
            height: 480,
          },
        ],
      },
    ]);

    const output = templateToString(el.render());
    const attachmentsIndex = output.indexOf('data-role="user-message-attachments"');
    const bubbleIndex = output.indexOf('data-role="user-message-bubble"');
    const bubbleHtml = output.slice(bubbleIndex, output.indexOf("</div>", bubbleIndex));

    expect(attachmentsIndex).toBeGreaterThan(-1);
    expect(bubbleIndex).toBeGreaterThan(-1);
    expect(attachmentsIndex).toBeLessThan(bubbleIndex);
    expect(bubbleHtml).toContain("what do you see?");
    expect(bubbleHtml).not.toContain("<img");
    expect(output).toContain("Open image full screen");
    expect(output).toContain("<button");
    expect(output).toContain("screen.png");
    expect(output).toContain("/api/sessions/sess-attachments/attachments/att_1");
    expect(output).toContain("width=640");
    expect(output).toContain("height=480");
    expect(output).toContain("aspect-ratio: 640 / 480");
  });

  test("right-aligns attached image previews without centering them in a stretched object box", () => {
    const el = new ChatPanel();
    Reflect.set(el, "store", { sessionId: "sess-attachments" });
    Reflect.set(el, "messages", [
      {
        role: "user",
        timestamp: 1,
        content: [
          {
            type: "image",
            attachmentId: "att_wide",
            mimeType: "image/png",
            filename: "wide-screen.png",
            byteSize: 123,
            width: 1600,
            height: 500,
          },
        ],
      },
    ]);

    const output = templateToString(el.render());

    expect(output).toContain("justify-items-end");
    expect(output).toContain("group ml-auto inline-flex max-w-full cursor-zoom-in justify-end");
    expect(output).toContain("block h-auto w-auto max-h-64 max-w-full");
    expect(output).not.toContain("object-contain");
  });
});
