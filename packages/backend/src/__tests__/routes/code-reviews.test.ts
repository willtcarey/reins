import { beforeEach, describe, expect, test } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../project-fixture.js";
import { createTask } from "../../task-store.js";
import { createSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createAppState } from "../helpers/app-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import type { WsClient } from "../../state.js";
import { getDb } from "../../injected-process-state.js";
import { Sessions } from "../../models/sessions.js";
import { useFakeModel } from "../helpers/fake-model.js";

/** The contents of the inputs Pi admitted for a session, in order. */
function admittedInputs(sessionId: string): unknown[] {
  return getDb().query<{ content: string }, [string]>("SELECT json_extract(message_json, '$.message.content') content FROM session_messages WHERE session_id = ? AND role = 'reinsInput' ORDER BY seq")
    .all(sessionId).map(row => JSON.parse(row.content));
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
  const model = useFakeModel();
  /** A session of the review's task on the fake model (no node is connected: its run waits for one). */
  const reviewSession = (id: string, modelId = model.model.modelId) =>
    createSession(id, projectId, { agentRuntimeType: "pi", taskId, modelProvider: model.model.provider, modelId });
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;
  let taskId: number;
  let sent: string[];
  let state: ReturnType<typeof createAppState>;

  beforeEach(() => {
    router = buildRouter();
    projectId = createProject("Review Project", repo.dir).id;
    taskId = createTask(projectId, "Review task", null, "task/review").id;
    sent = [];
    const client: WsClient = { ws: { send(data) { sent.push(data); return data.length; } } };
    state = createAppState({ clients: new Set([client]) });
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

  test("submits saved comments once to the selected idle session's runtime", async () => {
    reviewSession("session-1");
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
    expect(submitted).toEqual({ messageId: `code-review:${openReview.id}:${openReview.revision}` });
    expect(await (await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`),
      state,
    ))!.json()).toBeNull();
    const prompts = admittedInputs("session-1");
    const submittedPrompt: unknown = prompts[0];
    const text = Array.isArray(submittedPrompt) && submittedPrompt[0]?.type === "text"
      ? String(submittedPrompt[0].text)
      : "";
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
    reviewSession("session-1");
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
    expect(admittedInputs("session-1")).toHaveLength(1);
  });

  test("keeps the review when the session cannot admit its prompt", async () => {
    reviewSession("session-1", "missing");
    const created = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      { comment },
    ), state);
    const review = await created!.json();

    const response = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/submissions?taskId=${taskId}`,
      { reviewId: review.id, expectedRevision: review.revision, sessionId: "session-1" },
    ), state);

    expect(response?.status).toBe(500);
    expect(await (await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`), state,
    ))!.json()).toMatchObject({ id: review.id, revision: review.revision });
    expect(admittedInputs("session-1")).toEqual([]);
  });

  test("a prompt admitted before the review was consumed (a crash between the two) converges when submitted again", async () => {
    reviewSession("session-1");
    const created = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      { comment },
    ), state);
    const review = await created!.json();
    const clientId = `code-review:${review.id}:${review.revision}`;
    // The first step went through; the process went away before the review was consumed.
    await new Sessions(state, () => {}).submit("session-1", { op: "prompt", content: [{ type: "text", text: "the review" }], clientId });

    const response = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/submissions?taskId=${taskId}`,
      { reviewId: review.id, expectedRevision: review.revision, sessionId: "session-1" },
    ), state);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ messageId: clientId });
    expect(admittedInputs("session-1")).toHaveLength(1);
    expect(await (await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`), state,
    ))!.json()).toBeNull();
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
