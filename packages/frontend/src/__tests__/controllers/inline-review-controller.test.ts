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

const FILE = { id: "file-a", contentKey: "one", path: "src/a.ts", oldPath: null, lineText: (_side: "old" | "new", line: number) => line <= 3 ? `line ${line}` : null };

describe("InlineReviewController", () => {
  test("retains one draft across remount reconciliation and types without updating the host", () => {
    const host = new Host();
    const controller = new InlineReviewController(host, async () => { throw new Error("unused"); });
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
    });
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
});
