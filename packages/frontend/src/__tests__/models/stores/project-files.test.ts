import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ChatEvent } from "../../../models/chat-state.js";
import { FileReadError, ProjectFiles, type FileSource } from "../../../models/stores/project-files.js";
import { SessionCache } from "../../../models/stores/session-cache.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { StubClient } from "../../helpers/stub-client.js";

const source: FileSource = { projectId: 1, nodeId: "node-a", path: "/work/project", available: true };

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Files whose sessions are `here`, in `source`, and `elsewhere`, in another source of the project. */
function filesWithSessions() {
  const client = new StubClient();
  const sessions = new SessionCache();
  const placement = { available: true, removed: false, nodeId: "node-a", nodeName: "A" };
  sessions.set("here", { placement: { ...placement, path: "/work/project" } });
  sessions.set("elsewhere", { placement: { ...placement, path: "/work/other" } });
  return { client, files: new ProjectFiles(client, sessions) };
}

/** Session events, and the time for a change they announce to settle. */
async function fireEvents(client: StubClient, ...events: Array<[sessionId: string, event: ChatEvent]>) {
  jest.useFakeTimers();
  try {
    for (const [sessionId, event] of events) client.fireMessage({ type: "event", sessionId, projectId: 1, seq: 1, emittedAt: 0, event });
    jest.advanceTimersByTime(500);
  } finally {
    jest.useRealTimers();
  }
  await settle();
}

afterEach(() => restoreFetch());

describe("ProjectFiles listing", () => {
  test("loads a source's listing once and keeps it", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ files: ["README.md", "src/app.ts"] });
    });
    const files = new ProjectFiles(new StubClient(), new SessionCache());
    let notified = 0;
    files.subscribe(() => { notified += 1; });

    expect(files.listing(source).loading).toBe(true);
    await settle();

    expect(files.listing(source).data).toEqual(["README.md", "src/app.ts"]);
    expect(files.listing({ ...source }).data).toEqual(["README.md", "src/app.ts"]);
    // A source's files depend on its node and path; the project only routes the request.
    expect(files.listing({ ...source, projectId: 9 }).data).toEqual(["README.md", "src/app.ts"]);
    expect(requests).toEqual(["/api/projects/1/files"]);
    expect(notified).toBe(1);
  });

  test("lists nothing while the source's node is offline, and loads once it is connected", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ files: ["README.md"] });
    });
    const files = new ProjectFiles(new StubClient(), new SessionCache());

    expect(files.listing({ ...source, available: false }).data).toBeNull();
    await settle();
    expect(requests).toEqual([]);

    files.listing(source);
    await settle();
    expect(files.listing(source).data).toEqual(["README.md"]);
    expect(files.listing({ ...source, available: false }).data).toBeNull();
  });

  test("keeps each source's listing apart", async () => {
    mockFetch((url) => Response.json({ files: [url] }));
    const files = new ProjectFiles(new StubClient(), new SessionCache());
    const other: FileSource = { projectId: 2, nodeId: "node-b", path: "/work/project", available: true };

    files.listing(source);
    files.listing(other);
    await settle();

    expect(files.listing(source).data).toEqual(["/api/projects/1/files"]);
    expect(files.listing(other).data).toEqual(["/api/projects/2/files"]);
  });

  test("refreshes a source's listing when a file-modifying tool or a turn of its session ends", async () => {
    let version = 1;
    mockFetch(() => Response.json({ files: [`file-${version}.ts`] }));
    const { client, files } = filesWithSessions();
    const changed: unknown[] = [];
    files.onFilesChanged((changedSource) => changed.push(changedSource));
    files.listing(source);
    await settle();

    version = 2;
    await fireEvents(
      client,
      ["here", { type: "tool_execution_end", toolCallId: "t1", toolName: "read" }],
      ["elsewhere", { type: "agent_end" }],
      ["unplaced", { type: "agent_end" }],
    );
    expect(files.listing(source).data).toEqual(["file-1.ts"]);
    expect(changed).toEqual([{ nodeId: "node-a", path: "/work/other" }]);

    await fireEvents(client, ["here", { type: "tool_execution_end", toolCallId: "t2", toolName: "edit" }], ["here", { type: "agent_end" }]);
    expect(files.listing(source).data).toEqual(["file-2.ts"]);
    expect(changed).toEqual([{ nodeId: "node-a", path: "/work/other" }, { nodeId: "node-a", path: "/work/project" }]);
  });

  test("keeps the listing's files when a refresh finds them unchanged", async () => {
    mockFetch(() => Response.json({ files: ["README.md"] }));
    const { client, files } = filesWithSessions();
    files.listing(source);
    await settle();
    const before = files.listing(source).data;

    await fireEvents(client, ["here", { type: "agent_end" }]);

    expect(files.listing(source).data).toBe(before);
  });

  test("drops a superseded listing response, and keeps the listing when a refresh fails", async () => {
    const responses = [deferred(), deferred(), deferred()];
    let next = 0;
    mockFetch(() => responses[next++]!.promise);
    const { client, files } = filesWithSessions();
    files.listing(source);
    responses[0]!.resolve(Response.json({ files: ["first.ts"] }));
    await settle();

    await fireEvents(client, ["here", { type: "agent_end" }]);
    await fireEvents(client, ["here", { type: "agent_end" }]);
    responses[2]!.resolve(Response.json({ files: ["latest.ts"] }));
    await settle();
    responses[1]!.resolve(Response.json({ files: ["stale.ts"] }));
    await settle();
    expect(files.listing(source).data).toEqual(["latest.ts"]);

    mockFetch(() => Response.json({ error: "Node not connected" }, { status: 503 }));
    await fireEvents(client, ["here", { type: "agent_end" }]);
    expect(files.listing(source).data).toEqual(["latest.ts"]);
    expect(files.listing(source).error).toBe("Failed to load the file list");
  });
});

describe("ProjectFiles reads", () => {
  test("reads a text file every time it is asked for", async () => {
    let version = 0;
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      version += 1;
      return new Response(`v${version}`, { headers: { "content-type": "text/plain" } });
    });
    const files = new ProjectFiles(new StubClient(), new SessionCache());

    expect(await files.read(source, "src/index.ts")).toEqual({ text: "v1", isBinary: false });
    expect(await files.read(source, "src/index.ts")).toEqual({ text: "v2", isBinary: false });
    expect(requests).toEqual(["/api/projects/1/files/content?path=src%2Findex.ts", "/api/projects/1/files/content?path=src%2Findex.ts"]);
  });

  test("describes images and PDFs as binary", async () => {
    mockFetch((url) => new Response(new Blob([new Uint8Array(64)]), {
      headers: { "content-type": url.includes(".pdf") ? "application/pdf" : "image/png" },
    }));
    const files = new ProjectFiles(new StubClient(), new SessionCache());

    expect(await files.read(source, "assets/logo.png")).toEqual({ text: "Binary file (64 B)", isBinary: true });
    expect((await files.read(source, "docs/report.pdf")).isBinary).toBe(true);
  });

  test("rejects a missing file as not found", async () => {
    mockFetch(() => Response.json({ error: "not found" }, { status: 404 }));
    const files = new ProjectFiles(new StubClient(), new SessionCache());

    const error = await files.read(source, "gone.ts").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileReadError);
    expect(error).toMatchObject({ notFound: true, message: "File not found" });
  });

  test("lists a directory level and gives a file's own URL", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ entries: [{ name: "app.ts", type: "file" }] });
    });
    const files = new ProjectFiles(new StubClient(), new SessionCache());

    expect(await files.listDirectory(source, "src/components")).toEqual([{ name: "app.ts", type: "file" }]);
    expect(requests).toEqual(["/api/projects/1/files/tree?path=src%2Fcomponents"]);
    expect(files.contentUrl(source, "docs/a b.pdf", { download: true })).toBe("/api/projects/1/files/content?path=docs%2Fa+b.pdf&download=1");
  });
});
