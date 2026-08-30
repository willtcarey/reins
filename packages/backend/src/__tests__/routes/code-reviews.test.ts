import { beforeEach, describe, expect, test } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createTask } from "../../task-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import type { WsClient } from "../../state.js";

const annotation = {
  id: "annotation-client-1",
  anchor: {
    path: "src/example.ts",
    oldPath: null,
    side: "new",
    startLine: 4,
    endLine: 4,
    excerpt: "return value;",
    contextBefore: null,
    contextAfter: null,
    fileFingerprint: "file-v1",
    baseRevision: "base-sha",
    headRevision: "head-sha",
  },
  entry: {
    id: "entry-client-1",
    author: "Reviewer",
    body: "Please explain this.",
    createdAt: "2026-08-30T10:00:00.000Z",
  },
};

describe("code review routes", () => {
  useTestDb();
  const repo = useTestRepo();
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;
  let taskId: number;
  let sent: string[];
  let state: ReturnType<typeof createServerState>;

  beforeEach(() => {
    router = buildRouter();
    projectId = createProject("Review Project", repo.dir).id;
    taskId = createTask(projectId, "Review task", null, "task/review").id;
    sent = [];
    const client: WsClient = { ws: { send(data) { sent.push(data); return data.length; } } };
    state = createServerState({ clients: new Set([client]) });
  });

  test("uses one resource route set for task-scoped reviews", async () => {
    const resource = `/api/projects/${projectId}/code-review?taskId=${taskId}`;
    const empty = await router.handle(makeRequest("GET", resource), state);
    expect(empty?.status).toBe(200);
    expect(await empty!.json()).toBeNull();

    const created = await router.handle(makeRequest("POST", `/api/projects/${projectId}/code-review/annotations?taskId=${taskId}`, { annotation }), state);
    expect(created?.status).toBe(201);
    const review = await created!.json();
    expect(review).toMatchObject({ projectId, taskId, status: "open", revision: 1 });
    expect(review.annotations[0]).toEqual({ id: annotation.id, anchor: annotation.anchor, entries: [annotation.entry] });

    const loaded = await router.handle(makeRequest("GET", resource), state);
    expect(await loaded!.json()).toEqual(review);
    expect(JSON.parse(sent[0])).toEqual({
      type: "code_review_updated",
      projectId,
      taskId,
      reviewId: review.id,
      revision: 1,
      status: "open",
    });
    expect(sent[0]).not.toContain(annotation.entry.body);
  });

  test("omitting taskId uses the same resources in project scope", async () => {
    const resource = `/api/projects/${projectId}/code-review`;
    expect(await (await router.handle(makeRequest("GET", resource), state))!.json()).toBeNull();

    const created = await router.handle(makeRequest("POST", `${resource}/annotations`, { annotation }), state);
    expect(created?.status).toBe(201);
    const review = await created!.json();
    expect(review).toMatchObject({ projectId, taskId: null, status: "open", revision: 1 });
    expect(await (await router.handle(makeRequest("GET", resource), state))!.json()).toEqual(review);
  });

  test("accepts optional expected review identity as a concurrency guard", async () => {
    const path = `/api/projects/${projectId}/code-review/annotations?taskId=${taskId}`;
    const created = await router.handle(makeRequest("POST", path, { annotation }), state);
    const review = await created!.json();

    const retried = await router.handle(makeRequest("POST", path, {
      expectedReview: { id: review.id, revision: 0 },
      annotation,
    }), state);

    expect(retried?.status).toBe(200);
    expect(await retried!.json()).toEqual(review);
    expect(sent).toHaveLength(1);
  });

  test("validates transport input and translates model conflicts", async () => {
    const path = `/api/projects/${projectId}/code-review/annotations?taskId=${taskId}`;
    const malformedScope = await router.handle(
      makeRequest("POST", `/api/projects/${projectId}/code-review/annotations?taskId=nope`, { annotation }),
      state,
    );
    expect(malformedScope?.status).toBe(400);

    const invalidAnnotation = await router.handle(makeRequest("POST", path, {
      annotation: {
        ...annotation,
        anchor: { ...annotation.anchor, startLine: 5, endLine: 4 },
      },
    }), state);
    expect(invalidAnnotation?.status).toBe(400);

    const created = await router.handle(makeRequest("POST", path, { annotation }), state);
    const review = await created!.json();
    const stale = await router.handle(makeRequest("POST", path, {
      expectedReview: { id: review.id, revision: 0 },
      annotation: {
        ...annotation,
        id: "annotation-client-2",
        entry: { ...annotation.entry, id: "entry-client-2", body: "Another comment" },
      },
    }), state);

    expect(stale?.status).toBe(409);
    expect((await stale!.json()).error).toContain("revision");
    expect(sent).toHaveLength(1);
  });

  test("rejects a task from another project scope", async () => {
    const otherProject = createProject("Other", `${repo.dir}-other`).id;
    const otherTask = createTask(otherProject, "Other task", null, "task/other").id;
    const response = await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${otherTask}`),
      state,
    );
    expect(response?.status).toBe(404);
  });
});
