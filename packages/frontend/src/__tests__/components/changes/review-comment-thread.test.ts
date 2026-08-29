import { describe, expect, test } from "bun:test";
import { ReviewCommentThread } from "../../../components/changes/review-comment-thread.js";
import { ReviewComments } from "../../../models/changes/review-comments.js";
import { collectTemplateEventListeners, templateToString } from "../../helpers/lit-template.js";

describe("ReviewCommentThread", () => {
  test("renders a labeled composer and saves and deletes its Reins-owned thread", () => {
    const comments = new ReviewComments();
    comments.reconcile("scope", [{ fileId: "file-a", contentKey: "one" }]);
    comments.dispatch({
      type: "open-composer",
      fileId: "file-a",
      selection: { side: "new", startLine: 2, endLine: 4 },
    });
    const placementId = comments.project("file-a").placements[0]?.id;
    if (!placementId) throw new Error("Expected placement");
    const element = new ReviewCommentThread();
    element.comments = comments;
    element.fileId = "file-a";
    element.placementId = placementId;

    let rendered = element.render();
    let output = templateToString(rendered);
    expect(output).toContain("Comment on new lines 2–4");
    expect(output).toContain("Save comment");
    expect(output).toContain("Cancel comment");

    const input = collectTemplateEventListeners(rendered, "input")[0];
    const submit = collectTemplateEventListeners(rendered, "submit")[0];
    const inputEvent = new Event("input");
    Object.defineProperty(inputEvent, "currentTarget", {
      value: { value: "Please simplify this." },
    });
    input?.call(element, inputEvent);
    submit?.call(element, new Event("submit", { cancelable: true }));

    rendered = element.render();
    output = templateToString(rendered);
    expect(output).toContain("Please simplify this.");
    expect(output).toContain("Delete comment");

    collectTemplateEventListeners(rendered, "click")[0]?.call(element, new Event("click"));
    expect(comments.project("file-a").placements).toEqual([]);
  });
});
