import { describe, expect, test } from "bun:test";
import {
  CodeReview,
  CodeReviewError,
  type NewReviewAnnotation,
  type ReviewAnchorEvidence,
} from "../../models/code-review.js";

const originalAnchor: ReviewAnchorEvidence = {
  path: "src/example.ts",
  oldPath: null,
  side: "new",
  startLine: 12,
  endLine: 14,
  excerpt: "const answer = 41;\nreturn answer;",
  contextBefore: "function calculate() {",
  contextAfter: "}",
  fileFingerprint: "file-v1",
  baseRevision: "base-sha",
  headRevision: "head-sha",
};

function annotation(overrides: Partial<NewReviewAnnotation> = {}): NewReviewAnnotation {
  return {
    id: "annotation-1",
    anchor: originalAnchor,
    entry: {
      id: "entry-1",
      author: "Ada Lovelace",
      body: "This should return 42.",
      createdAt: "2026-08-29T10:01:00.000Z",
    },
    ...overrides,
  };
}

function review(): CodeReview {
  return CodeReview.restore({
    id: "review-1",
    projectId: 7,
    taskId: 11,
    status: "open",
    revision: 0,
    annotations: [],
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
  });
}

describe("CodeReview", () => {
  test("adds an anchored annotation and reply", () => {
    const codeReview = review();

    codeReview.addAnnotation(annotation());
    codeReview.addReply("annotation-1", {
      id: "entry-2",
      author: "Grace Hopper",
      body: "Agreed — I reproduced it.",
      createdAt: "2026-08-29T10:02:00.000Z",
    });

    expect(codeReview.annotations).toEqual([{
      id: "annotation-1",
      anchor: originalAnchor,
      entries: [
        {
          id: "entry-1",
          author: "Ada Lovelace",
          body: "This should return 42.",
          createdAt: "2026-08-29T10:01:00.000Z",
        },
        {
          id: "entry-2",
          author: "Grace Hopper",
          body: "Agreed — I reproduced it.",
          createdAt: "2026-08-29T10:02:00.000Z",
        },
      ],
    }]);
  });

  test("owns annotation validation and unique client identity", () => {
    const codeReview = review();
    const input = annotation();

    codeReview.addAnnotation(input);
    expect(() => codeReview.addAnnotation(input)).toThrow(CodeReviewError);
    expect(codeReview.annotations).toHaveLength(1);

    expect(() => codeReview.addAnnotation(annotation({
      entry: { ...input.entry, body: "Changed under the same identity" },
    }))).toThrow(CodeReviewError);
    let invalidError: unknown = null;
    try {
      codeReview.addAnnotation(annotation({
        id: "annotation-2",
        anchor: { ...originalAnchor, startLine: 15, endLine: 14 },
        entry: { ...input.entry, id: "entry-2" },
      }));
    } catch (error) {
      invalidError = error;
    }
    if (!(invalidError instanceof CodeReviewError)) throw invalidError;
    expect(invalidError.kind).toBe("invalid");

    codeReview.addAnnotation(annotation({
      id: "annotation-2",
      entry: { ...input.entry, id: "entry-2", sourceKey: "provider:comment:99" },
    }));
    expect(() => codeReview.addAnnotation(annotation({
      id: "annotation-3",
      entry: { ...input.entry, id: "entry-3", sourceKey: "provider:comment:99" },
    }))).toThrow(CodeReviewError);
  });

  test("upserts imported annotations by non-null source key across the review", () => {
    const codeReview = review();
    codeReview.upsertAnnotation(annotation({
      entry: {
        id: "import-1",
        author: "review-bot",
        body: "Initial finding",
        createdAt: "2026-08-29T10:01:00.000Z",
        sourceKey: "provider:comment:99",
        sourceUrl: "https://example.test/comments/99",
      },
    }));

    codeReview.upsertAnnotation(annotation({
      id: "unused-annotation-id",
      anchor: { ...originalAnchor, startLine: 30, endLine: 30, excerpt: "new location" },
      entry: {
        id: "unused-entry-id",
        author: "Automated Reviewer",
        body: "Updated finding",
        createdAt: "2026-08-29T10:05:00.000Z",
        sourceKey: "provider:comment:99",
        sourceUrl: "https://example.test/comments/99?updated=1",
      },
    }));

    expect(codeReview.annotations).toEqual([{
      id: "annotation-1",
      anchor: originalAnchor,
      entries: [{
        id: "import-1",
        author: "Automated Reviewer",
        body: "Updated finding",
        createdAt: "2026-08-29T10:01:00.000Z",
        sourceKey: "provider:comment:99",
        sourceUrl: "https://example.test/comments/99?updated=1",
      }],
    }]);
  });

  test("requires a source key for idempotent annotation upsert", () => {
    expect(() => review().upsertAnnotation(annotation())).toThrow("sourceKey");
  });

  test("owns terminal lifecycle transitions and rejects later annotation mutations", () => {
    const submitted = review();
    submitted.addAnnotation(annotation());
    submitted.markSubmitted();

    expect(submitted.status).toBe("submitted");
    expect(() => submitted.addReply("annotation-1", {
      id: "entry-2",
      author: "Grace Hopper",
      body: "Too late",
      createdAt: "2026-08-29T10:02:00.000Z",
    })).toThrow("submitted");
    expect(() => submitted.upsertAnnotation(annotation({
      id: "annotation-2",
      entry: {
        id: "entry-2",
        author: "review-bot",
        body: "Late import",
        createdAt: "2026-08-29T10:03:00.000Z",
        sourceKey: "provider:comment:100",
      },
    }))).toThrow("submitted");

    const abandoned = review();
    abandoned.abandon();

    expect(abandoned.status).toBe("abandoned");
    expect(() => abandoned.addAnnotation(annotation())).toThrow("abandoned");
    expect(() => abandoned.markSubmitted()).toThrow("abandoned");
  });
});
