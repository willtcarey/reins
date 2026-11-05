import { describe, expect, test } from "bun:test";
import { ReadToolBlock } from "../../../components/tools/read.js";
import { collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";

describe("ReadToolBlock image results", () => {
  const image = { type: "image" as const, data: "abc123", mimeType: "image/webp", filename: "diagram.webp" };

  test("shows its images with the shared thumbnails, also collapsed with text content, larger when expanded", () => {
    const el = new ReadToolBlock();
    el.path = "diagram.png";
    el.preview = "Image metadata";
    el.content = "Image metadata";
    el.sessionId = "sess-tool-image";
    el.images = [image];

    const collapsed = el.render();
    expect(templateToString(collapsed)).toContain("<tool-result-images");
    expect(collectTemplateProperties(collapsed, "images")).toEqual([[image]]);
    expect(collectTemplateProperties(collapsed, "sessionId")).toEqual(["sess-tool-image"]);
    expect(collectTemplateProperties(collapsed, "maxHeight")).toEqual(["max-h-48"]);

    Reflect.set(el, "expanded", true);
    expect(collectTemplateProperties(el.render(), "maxHeight")).toEqual(["max-h-96"]);
  });
});
