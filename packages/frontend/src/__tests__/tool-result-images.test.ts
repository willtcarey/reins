import { describe, expect, test } from "bun:test";
import { toolResultImages } from "../models/tools/images.js";
import { ToolResultImages } from "../components/tools/tool-result-images.js";
import type { ToolBlockData } from "../models/chat-state.js";
import { clickButton, templateToString } from "./helpers/lit-template.js";

type Content = NonNullable<ToolBlockData["result"]>["content"];
const block = (content: Content): ToolBlockData => ({ id: "t", name: "execute", args: {}, status: "done", result: { content } });
const inline = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
const attachment = { type: "image" as const, attachmentId: "att_1", mimeType: "image/png", byteSize: 10, sha256: "abc", filename: "shot.png" };

describe("toolResultImages", () => {
  test("a result's inline and attachment image blocks, in order; none for a result without images or a running call", () => {
    expect(toolResultImages(block([{ type: "text", text: "a" }, inline, attachment]))).toEqual([inline, attachment]);
    expect(toolResultImages(block([{ type: "text", text: "none" }]))).toEqual([]);
    expect(toolResultImages({ id: "x", name: "read", args: {}, status: "running" })).toEqual([]);
  });
});

describe("<tool-result-images>", () => {
  test("each image is a button that opens it full screen, named by its file name", () => {
    const element = new ToolResultImages();
    element.images = [inline, attachment];
    element.sessionId = "s1";
    const opened: unknown[] = [];
    element.addEventListener("open-image-viewer", event => opened.push(event instanceof CustomEvent ? event.detail : null));

    const rendered = element.render();
    expect(templateToString(rendered)).toContain("src=data:image/png;base64,iVBORw0KGgo=");
    clickButton(rendered, "Open image full screen: shot.png");

    expect(opened).toEqual([{ src: expect.stringContaining("att_1"), alt: "shot.png", title: "shot.png" }]);
  });
});
