import { beforeEach, describe, expect, test } from "bun:test";
import { createProject } from "../project-store.js";
import {
  CodeReviewRevisionConflictError,
  createCodeReview,
  deleteCodeReview,
  getCodeReview,
  getOpenCodeReview,
  saveCodeReview,
} from "../code-review-store.js";
import type { CodeReview } from "../models/code-review.js";
import { createTask } from "../task-store.js";
import { useTestDb } from "./helpers/test-db.js";

let projectId: number;
let taskId: number;

function addComment(review: CodeReview, body: string): void {
  review.addAnnotation({
    id: `annotation-${body}`,
    anchor: {
      path: "src/example.ts",
      oldPath: null,
      side: "new",
      startLine: 4,
      lines: [{ kind: "addition", text: "return value;" }],
      fileFingerprint: "file-v1",
      filePatch: "diff --git a/src/example.ts b/src/example.ts\n",
      baseRevision: "base-sha",
      headRevision: "head-sha",
    },
    entry: {
      id: `entry-${body}`,
      author: "Reviewer",
      body,
      createdAt: "2026-08-29T10:01:00.000Z",
    },
  });
}

describe("code review store", () => {
  useTestDb();

  beforeEach(() => {
    projectId = createProject("Review Project", "/tmp/review-project").id;
    taskId = createTask(projectId, "Review task", null, "task/review").id;
  });

  test("loads, mutates, and saves a detached review as a fresh revision", () => {
    createCodeReview({ id: "review-1", projectId, taskId });
    const loaded = getCodeReview("review-1");
    if (!loaded) throw new Error("Expected persisted code review");

    addComment(loaded, "First");
    const saved = saveCodeReview(loaded);

    expect(saved).not.toBe(loaded);
    expect(loaded.revision).toBe(0);
    expect(saved).toMatchObject({ id: "review-1", projectId, taskId, revision: 1 });
    expect(saved?.annotations[0]?.entries[0]?.body).toBe("First");
    expect(getCodeReview("review-1")).toMatchObject({
      revision: 1,
      annotations: [{ entries: [{ body: "First" }] }],
    });
  });

  test("allows only one open review in each task or project scope", () => {
    createCodeReview({ id: "task-review", projectId, taskId });
    createCodeReview({ id: "project-review", projectId, taskId: null });

    expect(() => createCodeReview({ id: "second-task-review", projectId, taskId })).toThrow();
    expect(() => createCodeReview({ id: "second-project-review", projectId, taskId: null })).toThrow();
    expect(getOpenCodeReview({ projectId, taskId })?.id).toBe("task-review");
    expect(getOpenCodeReview({ projectId, taskId: null })?.id).toBe("project-review");
  });

  test("rejects saving a stale detached revision", () => {
    const original = createCodeReview({ id: "review-1", projectId, taskId });
    const stale = getCodeReview(original.id);
    if (!stale) throw new Error("Expected persisted code review");

    addComment(original, "Ready");
    const saved = saveCodeReview(original);
    addComment(stale, "Stale");

    expect(() => saveCodeReview(stale)).toThrow(CodeReviewRevisionConflictError);
    expect(saved).toMatchObject({ revision: 1 });
    expect(getCodeReview("review-1")).toMatchObject({ revision: 1 });
  });

  test("returns null for a missing save and deletes persisted reviews", () => {
    const missing = createCodeReview({ id: "review-1", projectId, taskId });
    expect(deleteCodeReview("review-1")).toBe(true);
    expect(saveCodeReview(missing)).toBeNull();

    const review = createCodeReview({ id: "review-2", projectId, taskId });
    expect(deleteCodeReview(review.id)).toBe(true);
    expect(deleteCodeReview(review.id)).toBe(false);
    expect(getCodeReview(review.id)).toBeNull();
  });
});
