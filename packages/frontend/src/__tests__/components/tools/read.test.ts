import { describe, expect, test } from "bun:test";
import { ReadToolBlock } from "../../../components/tools/read.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("ReadToolBlock image results", () => {
  test("renders image results as buttons that can open the image viewer", () => {
    const el = new ReadToolBlock();
    el.sessionId = "sess-tool-image";
    el.images = [
      {
        type: "image",
        attachmentId: "att_tool",
        mimeType: "image/png",
        filename: "diagram.png",
        byteSize: 100,
      },
    ];

    const output = templateToString(el.render());

    expect(output).toContain("Open image full screen");
    expect(output).toContain("<button");
    expect(output).toContain("/api/sessions/sess-tool-image/attachments/att_tool");
    expect(output).toContain("diagram.png");
  });

  test("renders image previews in the collapsed result even when text content exists", () => {
    const el = new ReadToolBlock();
    el.path = "diagram.png";
    el.preview = "Image metadata";
    el.content = "Image metadata";
    el.sessionId = "sess-tool-image";
    el.images = [
      {
        type: "image",
        data: "abc123",
        mimeType: "image/webp",
        filename: "diagram.webp",
      },
    ];

    const output = templateToString(el.render());

    expect(output).toContain("Open image full screen");
    expect(output).toContain("data:image/webp;base64,abc123");
    expect(output).toContain("diagram.webp");
  });
});
