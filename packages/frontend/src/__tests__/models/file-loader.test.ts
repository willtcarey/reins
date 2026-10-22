import { afterEach, describe, expect, jest, test } from "bun:test";
import { FileLoader } from "../../models/file-loader.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { placedHost } from "../helpers/reins-sdk.js";

const source = { nodeId: "node", path: "/work" };

function newLoader() {
  return new FileLoader(placedHost({ source, projectId: 3 }).files);
}

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
    const loader = newLoader();

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
    const loader = newLoader();
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
    const loader = newLoader();

    loader.show(source, "gone.ts");
    await settle();

    expect(loader.content).toEqual({ loading: false, text: null, isBinary: false, error: "File not found" });
  });

  test("drops the response for a file no longer shown", async () => {
    const first = deferred();
    mockFetch((url) => (url.includes("first") ? first.promise : text("second")));
    const { sessions, files } = placedHost({ source, projectId: 3 });
    sessions.set("laptop", { projectId: 3, placement: { available: true, removed: false, nodeId: "laptop", nodeName: "Laptop", path: "/work" } });
    const loader = new FileLoader(files);

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
    const { client, sessions, files } = placedHost({ source, projectId: 3 });
    sessions.set("elsewhere", { projectId: 3, placement: { available: true, removed: false, nodeId: "node", nodeName: "Node", path: "/other" } });
    const loader = new FileLoader(files);
    loader.show(source, "a.ts");
    await settle();

    jest.useFakeTimers();
    client.fireMessage({ type: "event", sessionId: "elsewhere", projectId: 3, seq: 1, emittedAt: 0, event: { type: "agent_end" } });
    client.fireMessage({ type: "event", sessionId: "placed", projectId: 3, seq: 1, emittedAt: 0, event: { type: "agent_end" } });
    jest.advanceTimersByTime(500);
    jest.useRealTimers();
    await settle();

    expect(loader.content?.text).toBe("v2");
  });
});
