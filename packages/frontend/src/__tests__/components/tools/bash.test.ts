import { describe, expect, test } from "bun:test";
import { BashToolBlock, bashRenderer } from "../../../components/tools/bash.js";
import { collectTemplateEventListeners, collectTemplateProperties } from "../../helpers/lit-template.js";

const output = ["alpha", "bravo", "charlie", ""].join("\n");

describe("bash tool block", () => {
  test("a running command gets its output so far", () => {
    const rendered = bashRenderer.render({
      id: "call-1",
      name: "bash",
      args: { command: "make" },
      status: "running",
      result: { content: [{ type: "text", text: output }] },
    }, { source: null });
    expect(collectTemplateProperties(rendered, "output")).toEqual([output]);
    expect(collectTemplateProperties(rendered, "showSpinner")).toEqual([true]);
  });

  test("a running command previews its newest lines, and expands while it runs", () => {
    const block = new BashToolBlock();
    block.command = "make";
    block.output = output;
    block.showSpinner = true;
    const running = block.render();
    expect(collectTemplateProperties(running, "lines")).toEqual([["alpha", "bravo", "charlie"]]);
    expect(collectTemplateProperties(running, "preview")).toEqual(["newest"]);

    const [expand] = collectTemplateEventListeners(running, "click");
    expand!(new Event("click"));
    expect(collectTemplateProperties(block.render(), "expanded")).toEqual([true]);
  });

  test("a command that is done previews nothing", () => {
    const block = new BashToolBlock();
    block.output = output;
    expect(collectTemplateProperties(block.render(), "preview")).toEqual([null]);
  });
});
