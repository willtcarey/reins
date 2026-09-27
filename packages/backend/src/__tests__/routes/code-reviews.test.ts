import { beforeEach, describe, expect, test } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createTask } from "../../task-store.js";
import { createSession, updateActivityState } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import type { WsClient } from "../../state.js";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { registerExecutionTarget, type SessionExecutionTarget } from "../../runtimes/execution-target.js";
import { getDb } from "../../db.js";
import { createProvisionedNodeSession, queuePrompt } from "../helpers/node-session.js";
import { useFakeNode, type FakeNode } from "../helpers/fake-node.js";
import { createSource } from "../../node-store.js";

/** The prompt contents the fake node received for a session, once `count` arrived. */
async function promptsTo(node: FakeNode, sessionId: string, count: number): Promise<unknown[]> {
  const prompts = () => node.sent.flatMap(([command]) => command.op === "session.prompt" && command.sessionId === sessionId ? [command.content] : []);
  for (let i = 0; i < 100 && prompts().length < count; i++) await Bun.sleep(5);
  return prompts();
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

  test("submits saved comments once to the selected idle session, moving it onto its node first", async () => {
    createSession("session-1", projectId, { agentRuntimeType: "pi", taskId });
    const node = useFakeNode(state);
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
    const prompts = await promptsTo(node, "session-1", 1);
    expect(node.sent[0]?.[0].op).toBe("session.hydrate");
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
    createSession("session-1", projectId, { agentRuntimeType: "pi", taskId });
    const node = useFakeNode(state);
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
    expect(await promptsTo(node, "session-1", 1)).toHaveLength(1);
    await Bun.sleep(20);
    expect(await promptsTo(node, "session-1", 1)).toHaveLength(1);
  });

  test("keeps the review when durable prompt acceptance fails", async () => {
    // A session whose source is on a node this server cannot deliver to: queuing its input fails.
    getDb().query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    createSession("session-1", projectId, { agentRuntimeType: "pi", taskId, sourceId: createSource(projectId, "remote", "/remote/checkout").id });
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
  });

  test("consumes the review after durable prompt submission", async () => {
    createSession("session-1", projectId, { agentRuntimeType: "pi", taskId });
    useFakeNode(state);
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

    expect(response?.status).toBe(200);
    await Bun.sleep(0);
    expect(await (await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`), state,
    ))!.json()).toBeNull();
  });

  test("queues the review prompt for a running session instead of rejecting it", async () => {
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

    expect(response?.status).toBe(200);
    expect(await (await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`), state,
    ))!.json()).toBeNull();
    expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ?").get("running-session")).not.toBeNull();
  });

  test("delivers a node-owned session's review prompt through the command outbox, never a live runtime", async () => {
    createProvisionedNodeSession("node-session", projectId, { taskId });
    const delivered: NodeCommand[] = [];
    const target: SessionExecutionTarget = {
      async send(command): Promise<NodeResult> {
        delivered.push(command);
        return command.op === "session.prompt"
          ? { ok: true, value: { kind: "admitted", inputId: command.clientId } }
          : { ok: false, error: { code: "invalid_request", message: "unexpected", retryable: false } };
      },
    };
    registerExecutionTarget(state, target);
    const created = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      { comment },
    ), state);
    const review = await created!.json();
    const clientId = `code-review:${review.id}:${review.revision}`;

    const response = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/submissions?taskId=${taskId}`,
      { reviewId: review.id, expectedRevision: review.revision, sessionId: "node-session" },
    ), state);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ messageId: clientId });
    // The review was consumed in the same transaction that queued the prompt.
    expect(await (await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/code-review?taskId=${taskId}`), state,
    ))!.json()).toBeNull();
    for (let i = 0; i < 100 && delivered.length === 0; i++) await Bun.sleep(5);
    expect(delivered).toEqual([{
      op: "session.prompt", sessionId: "node-session", clientId,
      content: [{ type: "text", text: expect.stringContaining("You: Please explain this.") }], sourceSessionId: null,
    }]);
    // Delivered input leaves the outbox (the queue); the node's commit would prove its admission.
    for (let i = 0; i < 100 && getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = 'node-session'").get(); i++) await Bun.sleep(5);
    expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ?").get("node-session")).toBeNull();
  });

  test("queues the review prompt behind a node-owned session's earlier input", async () => {
    createProvisionedNodeSession("node-session", projectId, { taskId });
    queuePrompt("node-session", "earlier");
    const created = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/comments?taskId=${taskId}`,
      { comment },
    ), state);
    const review = await created!.json();

    const response = await router.handle(makeRequest(
      "POST",
      `/api/projects/${projectId}/code-review/submissions?taskId=${taskId}`,
      { reviewId: review.id, expectedRevision: review.revision, sessionId: "node-session" },
    ), state);

    expect(response?.status).toBe(200);
    expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') IS NOT NULL")
      .get("node-session")).toEqual({ n: 2 });
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
