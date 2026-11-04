import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ChatEvent } from "../../../models/chat-state.js";
import { FileReadError, ProjectFiles } from "../../../models/stores/project-files.js";
import { NodesStore } from "../../../models/stores/nodes-store.js";
import { SessionCache } from "../../../models/stores/session-cache.js";
import type { NodeView } from "@backend/models/node.js";
import type { Source } from "@reins/sdk";
import { Loadable } from "../../../helpers/loadable.js";
import { fileResponse, mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testNode } from "../../helpers/reins-sdk.js";
import { StubClient } from "../../helpers/stub-client.js";

const source: Source = { nodeId: "node-a", path: "/work/project" };
const sourceQuery = "root=%2Fwork%2Fproject";
const placement = { available: true, removed: false, nodeId: "node-a", nodeName: "A", path: "/work/project" };

/** Files of an app that knows no sessions and has not listed its nodes yet; `client` sends its node messages. */
function filesOnSource(client = new StubClient()) {
  return new ProjectFiles(client, new SessionCache(), new NodesStore(client));
}

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
  sessions.set("here", { projectId: 1, placement });
  sessions.set("elsewhere", { projectId: 1, placement: { ...placement, path: "/work/other" } });
  return { client, files: new ProjectFiles(client, sessions, new NodesStore(client)) };
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
  test("loads a source's listing once and keeps it, with no session on it", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ files: ["README.md", "src/app.ts"] });
    });
    const files = filesOnSource();
    let notified = 0;
    files.subscribe(() => { notified += 1; });

    expect(files.listing(source).loading).toBe(true);
    await settle();

    expect(files.listing(source).data).toEqual(["README.md", "src/app.ts"]);
    expect(files.listing({ ...source }).data).toEqual(["README.md", "src/app.ts"]);
    expect(requests).toEqual([`/api/nodes/node-a/files?${sourceQuery}`]);
    expect(notified).toBe(1);
  });

  test("lists nothing while the server says the source's node is offline, and reloads when the node connects or disconnects", async () => {
    let online = false;
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return online ? Response.json({ files: ["README.md"] }) : Response.json({ error: "Node not connected" }, { status: 503 });
    });
    const client = new StubClient();
    const nodes = new NodesStore(client);
    nodes.nodes = Loadable.idle<NodeView[]>().asLoaded([testNode("node-a", "NODE-A", false)]);
    const files = new ProjectFiles(client, new SessionCache(), nodes);
    let notified = 0;
    files.subscribe(() => { notified += 1; });
    const listed = `/api/nodes/node-a/files?${sourceQuery}`;

    files.listing(source);
    await settle();
    // Empty, not an error, and not asked again on the next ask.
    expect(files.listing(source)).toMatchObject({ data: null, loading: false, error: null });
    await settle();
    expect(requests).toEqual([listed]);

    online = true;
    client.fireMessage({ type: "node_updated", node: testNode("node-a", "NODE-A", true) });
    files.listing(source);
    await settle();
    expect(files.listing(source).data).toEqual(["README.md"]);
    expect(requests).toEqual([listed, listed]);

    online = false;
    client.fireMessage({ type: "node_updated", node: testNode("node-a", "NODE-A", false) });
    files.listing(source);
    await settle();
    expect(files.listing(source)).toMatchObject({ data: null, error: null });
    expect(requests).toEqual([listed, listed, listed]);
    expect(notified).toBeGreaterThan(0);
  });

  test("lists nothing for a node the server does not know: removed, or never paired", async () => {
    mockFetch(() => Response.json({ error: "Node not found: node-z" }, { status: 404 }));
    const files = filesOnSource();

    files.listing({ nodeId: "node-z", path: "/work" });
    await settle();

    expect(files.listing({ nodeId: "node-z", path: "/work" })).toMatchObject({ data: null, loading: false, error: null });
  });

  test("keeps each source's listing apart", async () => {
    mockFetch((url) => Response.json({ files: [url] }));
    const files = filesOnSource();
    const other: Source = { nodeId: "node-b", path: "/work/project" };

    files.listing(source);
    files.listing(other);
    await settle();

    expect(files.listing(source).data).toEqual([`/api/nodes/node-a/files?${sourceQuery}`]);
    expect(files.listing(other).data).toEqual([`/api/nodes/node-b/files?${sourceQuery}`]);
  });

  test("keeps only the listings of the two sources asked for last", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ files: [url] });
    });
    const files = filesOnSource();
    const other: Source = { nodeId: "node-b", path: "/work/project" };
    const third: Source = { nodeId: "node-c", path: "/work/project" };

    for (const asked of [source, other, source, third]) {
      files.listing(asked);
      await settle();
    }
    const listed = ["node-a", "node-b", "node-c"].map(nodeId => `/api/nodes/${nodeId}/files?${sourceQuery}`);
    expect(requests).toEqual(listed);

    expect(files.listing(source).data).toEqual([listed[0]]);
    expect(files.listing(other).data).toBeNull();
    await settle();
    expect(requests.at(-1)).toBe(listed[1]);
  });

  test("reloads a source's listing when it is next asked for after a file-modifying tool or a turn of its session ends", async () => {
    let version = 1;
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ files: [`file-${version}.ts`] });
    });
    const { client, files } = filesWithSessions();
    const changed: unknown[] = [];
    let notified = 0;
    files.onFilesChanged((changedSource) => changed.push(changedSource));
    files.listing(source);
    await settle();
    files.subscribe(() => { notified += 1; });

    version = 2;
    await fireEvents(
      client,
      ["here", { type: "tool_execution_end", toolCallId: "t1", toolName: "read" }],
      ["elsewhere", { type: "agent_end" }],
      ["unplaced", { type: "agent_end" }],
    );
    expect(files.listing(source).data).toEqual(["file-1.ts"]);
    expect(changed).toEqual([{ nodeId: "node-a", path: "/work/other" }]);
    expect(notified).toBe(0);

    await fireEvents(client, ["here", { type: "tool_execution_end", toolCallId: "t2", toolName: "edit" }], ["here", { type: "agent_end" }]);
    expect(changed).toEqual([{ nodeId: "node-a", path: "/work/other" }, { nodeId: "node-a", path: "/work/project" }]);
    expect(notified).toBe(1);
    // Nobody has asked for it again, so it has not been reloaded.
    expect(requests).toHaveLength(1);

    expect(files.listing(source)).toMatchObject({ data: ["file-1.ts"], loading: true });
    await settle();
    expect(files.listing(source).data).toEqual(["file-2.ts"]);
    expect(requests).toHaveLength(2);
  });

  test("keeps the listing's files when a reload finds them unchanged", async () => {
    mockFetch(() => Response.json({ files: ["README.md"] }));
    const { client, files } = filesWithSessions();
    files.listing(source);
    await settle();
    const before = files.listing(source).data;

    await fireEvents(client, ["here", { type: "agent_end" }]);
    files.listing(source);
    await settle();

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
    files.listing(source);
    await fireEvents(client, ["here", { type: "agent_end" }]);
    files.listing(source);
    responses[2]!.resolve(Response.json({ files: ["latest.ts"] }));
    await settle();
    responses[1]!.resolve(Response.json({ files: ["stale.ts"] }));
    await settle();
    expect(files.listing(source).data).toEqual(["latest.ts"]);

    mockFetch(() => Response.json({ error: "git ls-files failed" }, { status: 500 }));
    await fireEvents(client, ["here", { type: "agent_end" }]);
    files.listing(source);
    await settle();
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
      return fileResponse(`v${version}`);
    });
    const files = filesOnSource();

    expect(await files.read(source, "src/index.ts")).toEqual({ text: "v1", isBinary: false });
    expect(await files.read(source, "src/index.ts")).toEqual({ text: "v2", isBinary: false });
    const read = `/api/nodes/node-a/files/content?${sourceQuery}&path=src%2Findex.ts`;
    expect(requests).toEqual([read, read]);
  });

  test("describes images and PDFs as binary", async () => {
    mockFetch((url) => fileResponse(new Blob([new Uint8Array(64)]), { kind: "preview", contentType: url.includes(".pdf") ? "application/pdf" : "image/png" }));
    const files = filesOnSource();

    expect(await files.read(source, "assets/logo.png")).toEqual({ text: "Binary file (64 B)", isBinary: true });
    expect((await files.read(source, "docs/report.pdf")).isBinary).toBe(true);
  });

  test("shows a binary file as the server describes it, though it answers that in plain text", async () => {
    mockFetch(() => fileResponse("Binary file (2.0 MB). Download to view.", { kind: "binary" }));
    const files = filesOnSource();

    expect(await files.read(source, "build/app.bin")).toEqual({ text: "Binary file (2.0 MB). Download to view.", isBinary: true });
  });

  test("rejects a missing file as not found", async () => {
    mockFetch(() => Response.json({ error: "not found" }, { status: 404 }));
    const files = filesOnSource();

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
    const files = filesOnSource();

    expect(await files.listDirectory(source, "src/components")).toEqual([{ name: "app.ts", type: "file" }]);
    expect(requests).toEqual([`/api/nodes/node-a/files/tree?${sourceQuery}&path=src%2Fcomponents`]);
    expect(files.contentUrl(source, "docs/a b.pdf", { download: true })).toBe(`/api/nodes/node-a/files/content?${sourceQuery}&path=docs%2Fa+b.pdf&download=1`);
  });
});

describe("ProjectFiles node names", () => {
  test("names a source's node as the node list and its messages say", async () => {
    mockFetch(() => Response.json([testNode("node-a", "NODE-A", true)]));
    const client = new StubClient();
    const nodes = new NodesStore(client);
    const files = new ProjectFiles(client, new SessionCache(), nodes);

    expect(files.nodeName(source)).toBeNull();
    await nodes.load();
    expect(files.nodeName(source)).toBe("NODE-A");
    client.fireMessage({ type: "node_updated", node: { ...testNode("node-a", "NODE-A", false), name: "Renamed" } });
    expect(files.nodeName(source)).toBe("Renamed");
  });
});
