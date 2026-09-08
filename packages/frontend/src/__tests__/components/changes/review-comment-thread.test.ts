import { describe, expect, test } from "bun:test";
import { ReviewCommentThread } from "../../../components/changes/review-comment-thread.js";
import { collectTemplateEventListeners, templateToString } from "../../helpers/lit-template.js";

describe("ReviewCommentThread", () => {
  test("keeps typed draft presentation local while invoking narrow composer actions", async () => {
    const element = new ReviewCommentThread();
    let body = "";
    let saves = 0;
    let cancels = 0;
    element.placement = {
      id: "file-a:new:4",
      range: { side: "new", startLine: 2, endLine: 4 },
      comments: [],
      deletingCommentId: null,
      deleteComment: async () => {},
      composer: {
        body: "", saving: false, error: "Enter a comment before saving.",
        input: (value) => { body = value; },
        save: async () => { saves += 1; },
        cancel: () => { cancels += 1; },
      },
    };

    const rendered = element.render();
    const output = templateToString(rendered);
    expect(output).toContain("Comment on new lines 2–4");
    expect(output).toContain("Enter a comment before saving.");

    const inputEvent = new Event("input");
    Object.defineProperty(inputEvent, "currentTarget", { value: { value: "Please simplify this." } });
    collectTemplateEventListeners(rendered, "input")[0]?.call(element, inputEvent);
    expect(body).toBe("Please simplify this.");
    expect(templateToString(element.render())).not.toContain("Enter a comment before saving.");

    const previousConfirm = globalThis.confirm;
    let confirmation = "";
    globalThis.confirm = (message?: string) => {
      confirmation = message ?? "";
      return false;
    };
    try {
      const updated = element.render();
      collectTemplateEventListeners(updated, "click")[0]?.call(element, new Event("click"));
      expect(confirmation).toBe("Discard this inline comment draft?");
      expect(cancels).toBe(0);
    } finally {
      globalThis.confirm = previousConfirm;
    }

    collectTemplateEventListeners(element.render(), "submit")[0]?.call(element, new Event("submit", { cancelable: true }));
    await Promise.resolve();
    expect(saves).toBe(1);
  });

  test("offers deletion for each saved comment", async () => {
    const element = new ReviewCommentThread();
    const deleted: string[] = [];
    element.placement = {
      id: "file-a:new:4",
      range: { side: "new", startLine: 4, endLine: 4 },
      comments: [{ id: "entry-1", author: "You", body: "Remove this note." }],
      deletingCommentId: null,
      deleteComment: async (id) => { deleted.push(id); },
      composer: null,
    };

    const rendered = element.render();
    expect(templateToString(rendered)).toContain("Delete comment");
    collectTemplateEventListeners(rendered, "click")[0]?.call(element, new Event("click"));
    await Promise.resolve();

    expect(deleted).toEqual(["entry-1"]);
  });
});
