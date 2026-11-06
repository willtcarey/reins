import { describe, expect, test } from "bun:test";
import { EditToolBlock, editRenderer } from "../../../components/tools/edit.js";
import { WriteToolBlock, writeRenderer } from "../../../components/tools/write.js";
import { collectTemplateEventListeners, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";

const lines = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

describe("tool calls whose arguments are still streaming", () => {
  test("a file being written previews its newest lines, and expands while it runs", () => {
    const write = new WriteToolBlock();
    write.path = "notes.md";
    write.content = lines.join("\n");
    write.showSpinner = true;
    write.partialArgs = true;
    const writing = write.render();
    expect(collectTemplateProperties(writing, "lines")).toEqual([lines]);
    expect(collectTemplateProperties(writing, "preview")).toEqual(["newest"]);

    const [expand] = collectTemplateEventListeners(writing, "click");
    expand!(new Event("click"));
    expect(collectTemplateProperties(write.render(), "expanded")).toEqual([true]);

    write.partialArgs = false;
    write.showSpinner = false;
    expect(collectTemplateProperties(write.render(), "preview")).toEqual(["first"]);
  });

  test("a long file being written keeps its tail, numbered from where it starts", () => {
    const content = Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join("\n");
    const rendered = writeRenderer.render({ id: "w", name: "write", status: "running", partialArgs: true, args: { path: "big.txt", content } }, { source: null });

    const [shown] = collectTemplateProperties(rendered, "content");
    const [startLine] = collectTemplateProperties(rendered, "startLine");
    expect(typeof shown === "string" && shown.endsWith("line 2000")).toBe(true);
    expect(typeof shown === "string" && shown.startsWith(`line ${String(startLine)}\n`)).toBe(true);
    expect(startLine).toBeGreaterThan(1);
  });

  test("an edit being written previews its newest lines, and expands while it runs", () => {
    const block = { id: "edit-1", name: "edit", status: "running" as const, partialArgs: true as const, args: { path: "src/app.ts", edits: [{ oldText: "old", newText: lines.join("\n") }] } };
    const [diffLines] = collectTemplateProperties(editRenderer.render(block, { source: null }), "diffLines");
    expect(Array.isArray(diffLines) && diffLines.length).toBe(9);

    const edit = new EditToolBlock();
    edit.path = "src/app.ts";
    edit.showSpinner = true;
    edit.partialArgs = true;
    edit.diffLines = [{ type: "remove", text: "old", oldLine: 1 }, ...lines.map((text, index) => ({ type: "add" as const, text, newLine: index + 1 }))];
    const writing = edit.render();
    expect(collectTemplateProperties(writing, "lines")).toEqual([edit.diffLines]);
    expect(collectTemplateProperties(writing, "preview")).toEqual(["newest"]);

    const [expand] = collectTemplateEventListeners(writing, "click");
    expand!(new Event("click"));
    expect(collectTemplateProperties(edit.render(), "expanded")).toEqual([true]);
  });

  test("a path still being written does not open a file", () => {
    const write = new WriteToolBlock();
    write.source = { nodeId: "node", path: "/work/project" };
    write.path = "src/no";
    write.partialArgs = true;
    expect(templateToString(write.render())).not.toContain("Open in file browser");

    write.partialArgs = false;
    expect(templateToString(write.render())).toContain("Open in file browser");
  });
});
