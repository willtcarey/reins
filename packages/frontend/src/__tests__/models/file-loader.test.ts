import { afterEach, describe, expect, jest, test } from "bun:test";
import { FileLoader } from "../../models/file-loader.js";
import { ProjectFiles, type FileSource } from "../../models/stores/project-files.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { StubClient } from "../helpers/stub-client.js";
import { SessionCache } from "../../models/stores/session-cache.js";

const source: FileSource = { projectId: 3, nodeId: "node", path: "/work", available: true };

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function text(body: string) {
  return new Response(body, { headers: { "content-type": "text/plain" } });
}

afterEach(() => restoreFetch());

describe("FileLoader", () => {
  test("reads a file once while it is shown", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return text("hello world");
    });
    const loader = new FileLoader(new ProjectFiles(new StubClient(), new SessionCache()));

    loader.show(source, "src/index.ts");
    expect(loader.content?.loading).toBe(true);
    await settle();
    loader.show({ ...source }, "src/index.ts");

    expect(loader.content).toEqual({ loading: false, text: "hello world", isBinary: false, error: null });
    expect(requests).toEqual(["/api/projects/3/files/content?path=src%2Findex.ts"]);
  });

  test("a reload keeps showing the file until its new content arrives", async () => {
    let next = deferred();
    mockFetch(() => next.promise);
    const loader = new FileLoader(new ProjectFiles(new StubClient(), new SessionCache()));
    loader.show(source, "a.ts");
    next.resolve(text("old"));
    await settle();

    next = deferred();
    loader.show(source, "a.ts", { reload: true });
    expect(loader.content).toEqual({ loading: false, text: "old", isBinary: false, error: null });
    next.resolve(text("new"));
    await settle();

    expect(loader.content?.text).toBe("new");
  });

  test("reports a missing file", async () => {
    mockFetch(() => Response.json({ error: "not found" }, { status: 404 }));
    const loader = new FileLoader(new ProjectFiles(new StubClient(), new SessionCache()));

    loader.show(source, "gone.ts");
    await settle();

    expect(loader.content).toEqual({ loading: false, text: null, isBinary: false, error: "File not found" });
  });

  test("drops the response for a file no longer shown", async () => {
    const first = deferred();
    mockFetch((url) => (url.includes("first") ? first.promise : text("second")));
    const loader = new FileLoader(new ProjectFiles(new StubClient(), new SessionCache()));

    loader.show(source, "first.ts");
    loader.show({ ...source, nodeId: "laptop" }, "second.ts");
    await settle();
    first.resolve(text("first"));
    await settle();

    expect(loader.path).toBe("second.ts");
    expect(loader.content?.text).toBe("second");
  });

  test("reads its file again when its source's files may have changed", async () => {
    let version = 0;
    mockFetch(() => text(`v${++version}`));
    const client = new StubClient();
    const sessions = new SessionCache();
    const placement = { available: true, removed: false, nodeId: "node", nodeName: "Node" };
    sessions.set("here", { placement: { ...placement, path: "/work" } });
    sessions.set("elsewhere", { placement: { ...placement, path: "/other" } });
    const loader = new FileLoader(new ProjectFiles(client, sessions));
    loader.show(source, "a.ts");
    await settle();

    jest.useFakeTimers();
    client.fireMessage({ type: "event", sessionId: "elsewhere", projectId: 3, seq: 1, emittedAt: 0, event: { type: "agent_end" } });
    client.fireMessage({ type: "event", sessionId: "here", projectId: 3, seq: 1, emittedAt: 0, event: { type: "agent_end" } });
    jest.advanceTimersByTime(500);
    jest.useRealTimers();
    await settle();

    expect(loader.content?.text).toBe("v2");
  });
});
