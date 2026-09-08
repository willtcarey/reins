import { beforeEach, describe, expect, test } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createTask } from "../../task-store.js";
import { createSession, updateActivityState } from "../../session-store.js";
import { loadMessages } from "../../messages-store.js";
import type { AgentRuntime } from "../../runtimes/registry.js";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import type { WsClient } from "../../state.js";

function reviewRuntime(prompts: unknown[]): AgentRuntime {
  return {
    prompt(message) { prompts.push(message); return Promise.resolve(); },
    async steer() {},
    async abort() {},
    async setModel() {},
    subscribe() { return () => {}; },
    async getMessages() { return []; },
    isStreaming() { return false; },
    async close() {},
  };
}

const filePatch = `diff --git a/src/example.ts b/src/example.ts
index 8d57f20..4e0618a 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -2,3 +2,4 @@
 const value = calculate();
+return value;
-return oldValue;
`;

const comment = {
  path: "src/example.ts",
  side: "new" as const,
  startLine: 2,
  endLine: 3,
  filePatch,
  body: "Please explain this.",
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

    const created = await router.handle(makeRequest("POST", `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`, { comment }), state);
    expect(created?.status).toBe(201);
    const review = await created!.json();
    expect(review).toMatchObject({ projectId, taskId, revision: 1 });
    expect(review.annotations[0]).toMatchObject({
      id: expect.any(String),
      anchor: {
        path: "src/example.ts",
        side: "new",
        startLine: 2,
        lines: [
          { kind: "context", text: "const value = calculate();" },
          { kind: "addition", text: "return value;" },
        ],
        filePatch: comment.filePatch,
      },
      entries: [{ id: expect.any(String), author: "You", body: comment.body }],
    });

    const loaded = await router.handle(makeRequest("GET", resource), state);
    expect(await loaded!.json()).toEqual(review);
    expect(JSON.parse(sent[0])).toEqual({
      type: "code_review_updated",
      projectId,
      taskId,
      reviewId: review.id,
      revision: 1,
    });
    expect(sent[0]).not.toContain(comment.body);
  });

  test("omitting taskId uses the same resources in project scope", async () => {
    const resource = `/api/projects/${projectId}/code-review`;
    expect(await (await router.handle(makeRequest("GET", resource), state))!.json()).toBeNull();

    const created = await router.handle(makeRequest("POST", `${resource}/comments`, { comment }), state);
    expect(created?.status).toBe(201);
    const review = await created!.json();
    expect(review).toMatchObject({ projectId, taskId: null, revision: 1 });
    expect(await (await router.handle(makeRequest("GET", resource), state))!.json()).toEqual(review);
  });

  test("validates transport input and translates model conflicts", async () => {
    const path = `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`;
    const malformedScope = await router.handle(
      makeRequest("POST", `/api/projects/${projectId}/code-review/comments?taskId=nope`, { comment }),
      state,
    );
    expect(malformedScope?.status).toBe(400);

    const invalidComment = await router.handle(makeRequest("POST", path, {
      comment: { ...comment, startLine: 0 },
    }), state);
    expect(invalidComment?.status).toBe(400);

    const created = await router.handle(makeRequest("POST", path, { comment }), state);
    const review = await created!.json();
    const stale = await router.handle(makeRequest("POST", path, {
      expectedReview: { id: review.id, revision: 0 },
      comment: { ...comment, body: "Another comment" },
    }), state);

    expect(stale?.status).toBe(409);
    expect((await stale!.json()).error).toContain("revision");
    expect(sent).toHaveLength(1);
  });

  test("deletes a saved comment before submission", async () => {
    const created = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      { comment },
    ), state);
    const review = await created!.json();
    const commentId = review.annotations[0].entries[0].id;

    const response = await router.handle(makeRequest(
      "DELETE",
      `/api/projects/${projectId}/code-review/comments/${commentId}?taskId=${taskId}`,
      { expectedReview: { id: review.id, revision: review.revision } },
    ), state);
    const updated = await response!.json();

    expect(response?.status).toBe(200);
    expect(updated).toMatchObject({ id: review.id, revision: 2, annotations: [] });
    expect(await (await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`),
      state,
    ))!.json()).toEqual(updated);
    expect(JSON.parse(sent[1])).toMatchObject({
      type: "code_review_updated",
      reviewId: review.id,
      revision: 2,
    });
  });

  test("submits saved comments as one durable prompt to the selected idle session", async () => {
    createSession("session-1", projectId, { agentRuntimeType: "pi", taskId });
    const prompts: unknown[] = [];
    const runtime = reviewRuntime(prompts);
    state.sessions.set("session-1", { id: "session-1", runtime, lastActivity: Date.now() });
    const annotationResponse = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      { comment },
    ), state);
    const createdReview = await annotationResponse!.json();
    const replyResponse = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      {
        expectedReview: { id: createdReview.id, revision: createdReview.revision },
        comment: { ...comment, body: "This is a follow-up." },
      },
    ), state);
    const replyReview = await replyResponse!.json();
    const deletedLineResponse = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      {
        expectedReview: { id: replyReview.id, revision: replyReview.revision },
        comment: {
          ...comment,
          side: "old",
          startLine: 3,
          endLine: 3,
          body: "Remove this old path.",
        },
      },
    ), state);
    const openReview = await deletedLineResponse!.json();

    const response = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/submissions?taskId=${taskId}`,
      { reviewId: openReview.id, expectedRevision: openReview.revision, sessionId: "session-1" },
    ), state);
    const submitted = await response!.json();

    expect(response?.status).toBe(200);
    expect(submitted).toEqual({ messageId: expect.any(String) });
    expect(await (await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`),
      state,
    ))!.json()).toBeNull();
    const [message] = loadMessages("session-1");
    expect(message?.role).toBe("user");
    const text = message?.content?.[0]?.type === "text" ? message.content[0].text : "";
    expect(text).toBe([
      "src/example.ts",
      "",
      "Diff:",
      "    diff --git a/src/example.ts b/src/example.ts",
      "    index 8d57f20..4e0618a 100644",
      "    --- a/src/example.ts",
      "    +++ b/src/example.ts",
      "    @@ -2,3 +2,4 @@",
      "     const value = calculate();",
      "    +return value;",
      "    -return oldValue;",
      "",
      "You: Please explain this.",
      "↳ You: This is a follow-up.",
      "",
      "---",
      "",
      "src/example.ts",
      "",
      "Diff:",
      "    diff --git a/src/example.ts b/src/example.ts",
      "    index 8d57f20..4e0618a 100644",
      "    --- a/src/example.ts",
      "    +++ b/src/example.ts",
      "    @@ -2,3 +2,4 @@",
      "     const value = calculate();",
      "    +return value;",
      "    -return oldValue;",
      "",
      "You: Remove this old path.",
    ].join("\n"));
    expect(prompts).toEqual([[{ type: "text", text }]]);
  });

  test("deletes the accepted review so retries cannot duplicate its message", async () => {
    createSession("session-1", projectId, { agentRuntimeType: "pi", taskId });
    const prompts: unknown[] = [];
    const runtime = reviewRuntime(prompts);
    state.sessions.set("session-1", { id: "session-1", runtime, lastActivity: Date.now() });
    const created = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      { comment },
    ), state);
    const openReview = await created!.json();
    const submissionPath = `/api/projects/${projectId}/code-review/submissions?taskId=${taskId}`;
    const body = { reviewId: openReview.id, expectedRevision: openReview.revision, sessionId: "session-1" };

    const first = await router.handle(makeRequest("POST", submissionPath, body), state);
    const retry = await router.handle(makeRequest("POST", submissionPath, body), state);

    expect(first?.status).toBe(200);
    expect(retry?.status).toBe(409);
    expect(loadMessages("session-1")).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  test("rejects submission to an active or differently scoped session and keeps the review open", async () => {
    createSession("running-session", projectId, { agentRuntimeType: "pi", taskId });
    updateActivityState("running-session", "running");
    const created = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      { comment },
    ), state);
    const review = await created!.json();

    const response = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/submissions?taskId=${taskId}`,
      { reviewId: review.id, expectedRevision: review.revision, sessionId: "running-session" },
    ), state);
    const loaded = await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`),
      state,
    );

    expect(response?.status).toBe(409);
    expect(await loaded!.json()).toMatchObject({ id: review.id });
    expect(loadMessages("running-session")).toEqual([]);
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
