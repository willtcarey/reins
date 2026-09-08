import { describe, expect, test } from "bun:test";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { InlineReviewController } from "../../controllers/inline-review-controller.js";

class Host implements ReactiveControllerHost {
  updates = 0;
  addController(_controller: ReactiveController) {}
  removeController(_controller: ReactiveController) {}
  requestUpdate() { this.updates += 1; }
  updateComplete = Promise.resolve(true);
}

const FILE = {
  id: "file-a", contentKey: "one", path: "src/a.ts", oldPath: null,
  filePatch: "diff --git a/src/a.ts b/src/a.ts\n",
  diffLines: (side: "old" | "new") => [1, 2, 3].map((line) => ({
    kind: side === "old" ? "deletion" as const : "addition" as const,
    line,
    text: `line ${line}`,
  })),
};

describe("InlineReviewController", () => {
  test("retains one draft across remount reconciliation and types without updating the host", () => {
    const host = new Host();
    const controller = new InlineReviewController(
      host,
      async () => { throw new Error("unused"); },
      async () => { throw new Error("unused"); },
    );
    controller.reconcile("scope", [FILE]);
    controller.file("file-a").openComposer({ side: "new", startLine: 2, endLine: 2 });
    const updates = host.updates;
    controller.file("file-a").placements[0]?.composer?.input("Still editing");
    expect(host.updates).toBe(updates);
    controller.reconcile("scope", [FILE]);
    expect(controller.file("file-a").placements[0]?.composer?.body).toBe("Still editing");
    controller.reconcile("scope", [{ ...FILE, contentKey: "two" }]);
    expect(controller.file("file-a").placements).toEqual([]);
  });

  test("validates and saves through the file interface", async () => {
    const host = new Host();
    const saved: unknown[] = [];
    const controller = new InlineReviewController(host, async (annotation) => {
      saved.push(annotation);
      return { id: "review", projectId: 1, taskId: null, revision: 1,
        annotations: [{ id: annotation.id, anchor: annotation.anchor, entries: [annotation.entry] }], createdAt: "now", updatedAt: "now" };
    }, async () => { throw new Error("unused"); });
    controller.reconcile("scope", [FILE]);
    controller.file("file-a").openComposer({ side: "new", startLine: 2, endLine: 2 });
    await controller.file("file-a").placements[0]?.composer?.save();
    expect(controller.file("file-a").placements[0]?.composer?.error).toBe("Enter a comment before saving.");
    controller.file("file-a").placements[0]?.composer?.input("A note");
    await controller.file("file-a").placements[0]?.composer?.save();
    expect(saved).toHaveLength(1);
    expect(controller.file("file-a").placements[0]?.comments[0]?.body).toBe("A note");
    expect(controller.activeComposerFileId).toBeNull();
  });

  test("deletes a saved comment through its placement action", async () => {
    const host = new Host();
    const deleted: string[] = [];
    const controller = new InlineReviewController(
      host,
      async () => { throw new Error("unused"); },
      async (commentId) => { deleted.push(commentId); },
    );
    controller.reconcile("scope", [FILE]);
    controller.setReview({
      id: "review", projectId: 1, taskId: null, revision: 1,
      annotations: [{
        id: "annotation-1",
        anchor: {
          path: "src/a.ts", oldPath: null, side: "new", startLine: 2,
          lines: [{ kind: "addition", text: "line 2" }],
          fileFingerprint: "one", filePatch: FILE.filePatch,
          baseRevision: null, headRevision: null,
        },
        entries: [{ id: "entry-1", author: "You", body: "A note", createdAt: "now" }],
      }],
      createdAt: "now", updatedAt: "now",
    });

    const placement = controller.file("file-a").placements[0];
    placement?.addComment();
    expect(controller.file("file-a").placements[0]?.composer?.body).toBe("");
    expect(controller.file("file-a").placements[0]?.comments[0]?.body).toBe("A note");

    await placement?.deleteComment("entry-1");
    expect(deleted).toEqual(["entry-1"]);
  });
});
