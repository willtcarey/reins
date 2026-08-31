import { afterEach, describe, expect, test } from "bun:test";
import { CodeReviewStore, type CodeReviewState } from "../../../models/stores/code-review-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

const EMPTY_REVIEW: CodeReviewState = {
  id: "review-1",
  projectId: 7,
  taskId: 11,
  revision: 0,
  annotations: [],
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
};

afterEach(() => restoreFetch());

describe("CodeReviewStore", () => {
  test("loads the open review for the active project and task scope", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json(EMPTY_REVIEW);
    });
    const store = new CodeReviewStore();

    await store.setScope({ projectId: 7, taskId: 11 });

    expect(requests).toEqual(["/api/projects/7/code-review?taskId=11"]);
    expect(store.review).toEqual(EMPTY_REVIEW);
    expect(store.error).toBeNull();
  });

  test("saves an annotation with the current optimistic review identity", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch((url, init) => {
      requests.push({ url, init });
      if (!init) return Response.json(EMPTY_REVIEW);
      return Response.json({
        ...EMPTY_REVIEW,
        revision: 1,
        annotations: [{
          id: "annotation-1",
          anchor: {
            path: "src/example.ts",
            oldPath: null,
            side: "new",
            startLine: 2,
            endLine: 2,
            excerpt: "const answer = 42;",
            contextBefore: null,
            contextAfter: null,
            fileFingerprint: "content-1",
            baseRevision: null,
            headRevision: null,
          },
          entries: [{
            id: "entry-1",
            author: "You",
            body: "Please explain this.",
            createdAt: "2026-08-30T10:01:00.000Z",
          }],
        }],
      });
    });
    const store = new CodeReviewStore();
    await store.setScope({ projectId: 7, taskId: 11 });

    await store.addAnnotation({
      id: "annotation-1",
      anchor: {
        path: "src/example.ts",
        oldPath: null,
        side: "new",
        startLine: 2,
        endLine: 2,
        excerpt: "const answer = 42;",
        contextBefore: null,
        contextAfter: null,
        fileFingerprint: "content-1",
        baseRevision: null,
        headRevision: null,
      },
      entry: {
        id: "entry-1",
        author: "You",
        body: "Please explain this.",
        createdAt: "2026-08-30T10:01:00.000Z",
      },
    });

    expect(requests[1]?.url).toBe("/api/projects/7/code-review/annotations?taskId=11");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      expectedReview: { id: "review-1", revision: 0 },
      annotation: expect.objectContaining({ id: "annotation-1" }),
    });
    expect(store.review?.revision).toBe(1);
    expect(store.review?.annotations[0]?.entries[0]?.body).toBe("Please explain this.");
  });

  test("submits the current open review to a session and exposes progress", async () => {
    let resolveResponse!: (response: Response) => void;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch((url, init) => {
      requests.push({ url, init });
      if (!init) return Response.json({ ...EMPTY_REVIEW, annotations: [{ id: "annotation-1", anchor: {}, entries: [] }] });
      return new Promise<Response>((resolve) => { resolveResponse = resolve; });
    });
    const store = new CodeReviewStore();
    await store.setScope({ projectId: 7, taskId: 11 });

    const submission = store.submit("session-1");
    expect(store.submitting).toBe(true);
    resolveResponse(Response.json({ messageId: "42" }));
    expect(await submission).toEqual({ messageId: "42" });

    expect(requests[1]?.url).toBe("/api/projects/7/code-review/submissions?taskId=11");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      reviewId: "review-1",
      expectedRevision: 0,
      sessionId: "session-1",
    });
    expect(store.submitting).toBe(false);
    expect(store.review).toBeNull();
  });

  test("retains submission errors beside the open review", async () => {
    mockFetch((_url, init) => init
      ? Response.json({ error: "Session is currently running" }, { status: 409 })
      : Response.json({ ...EMPTY_REVIEW, annotations: [{ id: "annotation-1", anchor: {}, entries: [] }] }));
    const store = new CodeReviewStore();
    await store.setScope({ projectId: 7, taskId: 11 });

    await expect(store.submit("session-1")).rejects.toThrow("Session is currently running");

    expect(store.submitting).toBe(false);
    expect(store.submissionError).toBe("Session is currently running");
    expect(store.review?.id).toBe("review-1");
  });

  test("reloads only for a newer invalidation in the active scope", async () => {
    let loads = 0;
    mockFetch(() => Response.json({ ...EMPTY_REVIEW, revision: loads++ }));
    const store = new CodeReviewStore();
    await store.setScope({ projectId: 7, taskId: 11 });

    await store.handleUpdated({
      projectId: 7,
      taskId: 11,
      reviewId: "review-1",
      revision: 2,
    });
    await store.handleUpdated({
      projectId: 7,
      taskId: 12,
      reviewId: "other-review",
      revision: 3,
    });

    expect(loads).toBe(2);
  });
});
