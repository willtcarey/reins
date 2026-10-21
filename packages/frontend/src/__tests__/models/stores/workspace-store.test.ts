import { afterEach, describe, expect, jest, test } from "bun:test";
import { AppStore } from "../../../models/stores/app-store.js";
import { WorkspaceStore } from "../../../models/stores/workspace-store.js";
import { StubClient } from "../../helpers/stub-client.js";
import { messagePage } from "../../helpers/conversations.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionDetail(id: string, projectId: number, taskId: number) {
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
    placement: { status: "server" as const, error: null, available: true, removed: false, nodeId: "internal", nodeName: "Internal", path: "/work/project" },
    state: { model: null, thinkingLevel: "off" },
  };
}

describe("WorkspaceStore session transitions", () => {
  afterEach(() => restoreFetch());

  test("opens files only for the mounted session", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/current") return Response.json(sessionDetail("current", 1, 10));
      if (url === "/api/sessions/current/messages") return Response.json(messagePage());
      if (url === "/api/projects/1/tasks?status=open") {
        return Response.json([{ id: 10, branch_name: "branch-1" }]);
      }
      return Response.json([]);
    });

    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const fakeDocument = new EventTarget();
    Object.defineProperty(globalThis, "document", { value: fakeDocument, configurable: true });
    const client = new StubClient();
    const runtime = new AppStore(client);
    runtime.projectsStore.projects = [{
      id: 1,
      name: "Project",
      base_branch: "main",
      created_at: "",
      last_opened_at: "",
    }];
    const workspace = new WorkspaceStore(runtime);

    try {
      await workspace.setSession("current");
      expect(workspace.source?.path).toBe("/work/project");
      const opened: unknown[] = [];
      fakeDocument.addEventListener("open-in-browser", (event) => {
        if (!(event instanceof CustomEvent)) throw new Error("Expected file-open detail");
        opened.push(event.detail);
      });

      client.fireMessage({ type: "open_file", sessionId: "other", projectId: 1, path: "ignored.ts" });
      client.fireMessage({
        type: "open_file",
        sessionId: "current",
        projectId: 1,
        path: "/work/project/opened.ts",
        startLine: 2,
        endLine: 4,
      });

      expect(opened).toEqual([{
        source: { projectId: 1, nodeId: "internal", path: "/work/project", available: true },
        path: "opened.ts",
        startLine: 2,
        endLine: 4,
      }]);
    } finally {
      workspace.dispose();
      runtime.dispose();
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("clears stale scopes immediately and ignores a superseded session transition", async () => {
    const details = new Map([
      ["first", deferredResponse()],
      ["second", deferredResponse()],
      ["third", deferredResponse()],
    ]);
    mockFetch((url) => {
      const detailMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
      if (detailMatch) return details.get(detailMatch[1]!)!.promise;
      if (url.match(/^\/api\/sessions\/[^/]+\/messages$/)) return Response.json(messagePage());
      const tasksMatch = url.match(/^\/api\/projects\/(\d+)\/tasks\?status=open$/);
      if (tasksMatch) {
        const projectId = Number(tasksMatch[1]);
        return Response.json([{ id: projectId * 10, branch_name: `branch-${projectId}` }]);
      }
      if (url.match(/^\/api\/projects\/\d+\/(sessions|skills)$/)) return Response.json([]);
      if (url.startsWith("/api/projects/") && url.includes("/diff/")) return Response.json([]);
      return Response.json([]);
    });

    const runtime = new AppStore(new StubClient());
    const workspace = new WorkspaceStore(runtime);

    const first = workspace.setSession("first");
    details.get("first")!.resolve(Response.json(sessionDetail("first", 1, 10)));
    await first;

    expect(workspace.sessionId).toBe("first");
    expect(workspace.diffStore.projectId).toBe(1);
    expect(workspace.diffStore.branch).toBe("branch-1");
    expect(workspace.codeReviewStore.scope).toEqual({ projectId: 1, taskId: 10 });

    const second = workspace.setSession("second");

    expect(workspace.sessionId).toBe("second");
    expect(workspace.diffStore.projectId).toBeNull();
    expect(workspace.codeReviewStore.scope).toBeNull();

    const third = workspace.setSession("third");
    details.get("second")!.resolve(Response.json(sessionDetail("second", 2, 20)));
    await second;

    expect(workspace.sessionId).toBe("third");
    expect(workspace.diffStore.projectId).toBeNull();
    expect(workspace.codeReviewStore.scope).toBeNull();

    details.get("third")!.resolve(Response.json(sessionDetail("third", 3, 30)));
    await third;

    expect(workspace.sessionId).toBe("third");
    expect(workspace.projectId).toBe(3);
    expect(workspace.diffStore.projectId).toBe(3);
    expect(workspace.diffStore.branch).toBe("branch-3");
    expect(workspace.codeReviewStore.scope).toEqual({ projectId: 3, taskId: 30 });

    workspace.dispose();
    runtime.dispose();
  });
});

describe("WorkspaceStore Inspector and files", () => {
  afterEach(() => restoreFetch());

  function serveSessions(sessions: Record<string, ReturnType<typeof sessionDetail>>, requests: string[] = []) {
    mockFetch((url) => {
      requests.push(url);
      const detail = url.match(/^\/api\/sessions\/([^/]+)$/);
      if (detail) return Response.json(sessions[detail[1]!]);
      if (url.match(/^\/api\/sessions\/[^/]+\/messages$/)) return Response.json(messagePage());
      const tasks = url.match(/^\/api\/projects\/(\d+)\/tasks\?status=open$/);
      if (tasks) return Response.json([{ id: Number(tasks[1]) * 10, branch_name: `branch-${tasks[1]}` }]);
      if (url.match(/^\/api\/projects\/\d+\/files$/)) return Response.json({ files: ["README.md"] });
      return Response.json([]);
    });
  }

  test("opens views in the project's Inspector, which session changes within the project keep", async () => {
    serveSessions({
      first: sessionDetail("first", 1, 10),
      second: sessionDetail("second", 1, 10),
      other: sessionDetail("other", 2, 20),
    });
    const runtime = new AppStore(new StubClient());
    const workspace = new WorkspaceStore(runtime);

    await workspace.setSession("first");
    workspace.open({ view: "file", path: "README.md", startLine: 4 }, { in: "inspector" });
    await workspace.setSession("second");

    expect(workspace.inspector?.tabs.map((tab) => tab.view)).toEqual([
      { view: "changes" },
      { view: "file", path: "README.md", startLine: 4 },
    ]);
    expect(workspace.inspector?.activeTab.view).toEqual({ view: "file", path: "README.md", startLine: 4 });

    await workspace.setSession("other");
    expect(workspace.inspector?.tabs.map((tab) => tab.view)).toEqual([{ view: "changes" }]);

    workspace.dispose();
    runtime.dispose();
  });

  test("works in the viewed session's source", async () => {
    const moved = { ...sessionDetail("moved", 1, 10), placement: { ...sessionDetail("moved", 1, 10).placement, nodeId: "laptop", path: "/laptop/project", available: false } };
    serveSessions({ first: sessionDetail("first", 1, 10), moved });
    const runtime = new AppStore(new StubClient());
    const workspace = new WorkspaceStore(runtime);

    await workspace.setSession("first");
    expect(workspace.source).toEqual({ projectId: 1, nodeId: "internal", path: "/work/project", available: true });
    expect(workspace.source).toBe(workspace.source);

    await workspace.setSession("moved");
    expect(workspace.source).toEqual({ projectId: 1, nodeId: "laptop", path: "/laptop/project", available: false });

    workspace.dispose();
    runtime.dispose();
  });

  test("refreshes the diff when its source's files may have changed", async () => {
    const requests: string[] = [];
    serveSessions({ first: sessionDetail("first", 1, 10) }, requests);
    const client = new StubClient();
    const runtime = new AppStore(client);
    const workspace = new WorkspaceStore(runtime);
    await workspace.setSession("first");
    const diffRequests = () => requests.filter((url) => url.startsWith("/api/projects/1/diff/files")).length;
    const placement = sessionDetail("first", 1, 10).placement;
    runtime.sessionCache.set("same-source", { placement });
    runtime.sessionCache.set("other-source", { placement: { ...placement, path: "/work/other" } });
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

    workspace.dispose();
    runtime.dispose();
  });
});
