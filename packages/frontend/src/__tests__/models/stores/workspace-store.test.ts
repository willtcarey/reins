import { afterEach, describe, expect, test } from "bun:test";
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
    location: { state: "server" as const },
    moveTargetCount: 1,
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
      path: "/work/project",
      base_branch: "main",
      created_at: "",
      last_opened_at: "",
    }];
    const workspace = new WorkspaceStore(runtime);

    try {
      await workspace.setSession("current");
      expect(workspace.projectDir).toBe("/work/project");
      const opened: Array<{ projectId: number; path: string; startLine?: number; endLine?: number }> = [];
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

      expect(opened).toEqual([{ projectId: 1, path: "opened.ts", startLine: 2, endLine: 4 }]);
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
