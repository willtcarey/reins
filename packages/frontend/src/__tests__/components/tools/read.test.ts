import { describe, expect, test } from "bun:test";
import { ReadToolBlock } from "../../../components/tools/read.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("ReadToolBlock image results", () => {
  test("renders image results as buttons that can open the image viewer", () => {
    const el = new ReadToolBlock();
    Reflect.set(el, "sessionId", "sess-tool-image");
    Reflect.set(el, "images", [
      {
        type: "image",
        attachmentId: "att_tool",
        mimeType: "image/png",
        filename: "diagram.png",
        byteSize: 100,
      },
    ]);

    const output = templateToString(el.render());

    expect(output).toContain("Open image full screen");
    expect(output).toContain("<button");
    expect(output).toContain("/api/sessions/sess-tool-image/attachments/att_tool");
    expect(output).toContain("diagram.png");
  });
});
