import { afterEach, describe, expect, jest, test } from "bun:test";
import { AppStore } from "../../../models/stores/app-store.js";
import { StubClient } from "../../helpers/stub-client.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

function sessionDetail(id: string, projectId: number | null, taskId: number | null, path = "/work/project") {
  return {
    id,
    projectId,
    taskId,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    activityState: null,
    messageCount: 0,
    placement: { status: "server" as const, error: null, available: true, removed: false, nodeId: "internal", nodeName: "Internal", path },
    state: { model: null, thinkingLevel: "off" },
  };
}

function serveSessions(sessions: Record<string, ReturnType<typeof sessionDetail>>, requests: string[] = []) {
  mockFetch((url) => {
    requests.push(url);
    const detail = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (detail) return Response.json(sessions[detail[1]!]);
    const tasks = url.match(/^\/api\/projects\/(\d+)\/tasks\?status=open$/);
    if (tasks) return Response.json([{ id: Number(tasks[1]) * 10, branch_name: `branch-${tasks[1]}` }]);
    if (url.includes("/diff/files")) return Response.json({ files: [], branch: null, baseBranch: null });
    return Response.json([]);
  });
}

/** Lets the entry's scoping (the session's details, its project's tasks) settle. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SessionDiffs", () => {
  afterEach(() => restoreFetch());

  test("scopes a session's diff and review to its project, task and branch once its details are known", async () => {
    serveSessions({ s1: sessionDetail("s1", 1, 10) });
    const app = new AppStore(new StubClient());

    const { diff, release } = app.diffs.use("s1");
    expect(diff.files.sessionId).toBeNull();
    await settle();

    expect(diff.source).toEqual({ nodeId: "internal", path: "/work/project" });
    expect(diff.projectId).toBe(1);
    expect(diff.files.sessionId).toBe("s1");
    expect(diff.files.branch).toBe("branch-1");
    expect(diff.review.scope).toEqual({ projectId: 1, taskId: 10 });
    release();
    app.dispose();
  });

  test("diffs a session of no project with no review", async () => {
    serveSessions({ s1: sessionDetail("s1", null, null) });
    const app = new AppStore(new StubClient());

    const { diff, release } = app.diffs.use("s1");
    await settle();

    expect(diff.files.sessionId).toBe("s1");
    expect(diff.review.scope).toBeNull();
    release();
    app.dispose();
  });

  test("is one entry per session while it is used, and a new one once every user released it", async () => {
    serveSessions({ s1: sessionDetail("s1", 1, 10), s2: sessionDetail("s2", 1, 10) });
    const app = new AppStore(new StubClient());

    const review = app.diffs.use("s1");
    const tree = app.diffs.use("s1");
    const other = app.diffs.use("s2");
    expect(tree.diff).toBe(review.diff);
    expect(other.diff).not.toBe(review.diff);

    review.release();
    review.release();
    expect(app.diffs.use("s1").diff).toBe(tree.diff);
    tree.release();

    await settle();
    app.dispose();
  });

  test("keeps what it shows for its session: branch or uncommitted changes", async () => {
    serveSessions({ s1: sessionDetail("s1", 1, 10), s2: sessionDetail("s2", 1, 10) });
    const app = new AppStore(new StubClient());
    const first = app.diffs.use("s1");
    const second = app.diffs.use("s2");
    await settle();

    await first.diff.files.setDiffMode("uncommitted");

    expect(second.diff.files.diffMode).toBe("branch");
    first.release();
    expect(app.diffs.use("s1").diff.files.diffMode).toBe("branch");
    second.release();
    app.dispose();
  });

  test("refreshes the diff when its source's files may have changed", async () => {
    const requests: string[] = [];
    serveSessions({ s1: sessionDetail("s1", 1, 10) }, requests);
    const client = new StubClient();
    const app = new AppStore(client);
    const { release } = app.diffs.use("s1");
    await settle();
    const diffRequests = () => requests.filter((url) => url.startsWith("/api/sessions/s1/diff/files")).length;
    const placement = sessionDetail("s1", 1, 10).placement;
    app.sessionCache.set("same-source", { placement });
    app.sessionCache.set("other-source", { placement: { ...placement, path: "/work/other" } });
    const turnEnded = (sessionId: string) => {
      jest.useFakeTimers();
      client.fireMessage({ type: "event", sessionId, projectId: 1, seq: 1, emittedAt: 0, event: { type: "agent_end" } });
      jest.advanceTimersByTime(500);
      jest.useRealTimers();
    };
    const before = diffRequests();

    turnEnded("other-source");
    expect(diffRequests()).toBe(before);
    turnEnded("same-source");
    await Promise.resolve();

    expect(diffRequests()).toBe(before + 1);
    release();
    app.dispose();
  });

  test("reloads its review when the server says the review of its task changed", async () => {
    const requests: string[] = [];
    serveSessions({ s1: sessionDetail("s1", 1, 10) }, requests);
    const client = new StubClient();
    const app = new AppStore(client);
    const { release } = app.diffs.use("s1");
    await settle();
    const reviewRequests = () => requests.filter((url) => url.includes("/code-review")).length;
    const before = reviewRequests();

    client.fireMessage({ type: "code_review_updated", projectId: 1, taskId: 99, reviewId: "r", revision: 1 });
    client.fireMessage({ type: "code_review_updated", projectId: 1, taskId: 10, reviewId: "r", revision: 1 });
    await settle();

    expect(reviewRequests()).toBe(before + 1);
    release();
    app.dispose();
  });
});
