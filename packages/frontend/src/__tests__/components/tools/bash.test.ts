import { describe, expect, test } from "bun:test";
import { BashToolBlock, bashRenderer } from "../../../components/tools/bash.js";
import { collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";

describe("bash tool block", () => {
  test("a running command shows its output so far without being expanded, and hides it once done", () => {
    const rendered = bashRenderer.render({
      id: "call-1",
      name: "bash",
      args: { command: "make" },
      status: "running",
      result: { content: [{ type: "text", text: "compiling a\ncompiling b" }] },
    }, { source: null });
    expect(collectTemplateProperties(rendered, "output")).toEqual(["compiling a\ncompiling b"]);
    expect(collectTemplateProperties(rendered, "showSpinner")).toEqual([true]);

    const block = new BashToolBlock();
    block.command = "make";
    block.output = "compiling a\ncompiling b";
    block.showSpinner = true;
    // Once it has run a moment (a quick command never opens its output).
    Reflect.set(block, "live", true);
    expect(templateToString(block.render())).toContain("compiling a\ncompiling b");

    block.showSpinner = false;
    Reflect.set(block, "live", false);
    expect(templateToString(block.render())).not.toContain("compiling a");
  });
});
