import { afterEach, describe, expect, jest, test } from "bun:test";
import { FileBrowserStore } from "../../../models/stores/file-browser-store.js";
import { fakeXhr } from "../../helpers/fake-xhr.js";
import { fileResponse, mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testNode, testSdk } from "../../helpers/reins-sdk.js";

const source = { nodeId: "node-a", path: "/work/project" };

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function browser(options: { available?: boolean; viewedSource?: () => typeof source | null } = {}) {
  const { viewedSource = () => source, ...sdkOptions } = options;
  const sdk = testSdk({ source, projectId: 1, ...sdkOptions });
  return { ...sdk, store: new FileBrowserStore(sdk.reins, { viewedSource }) };
}

/** A project file server: listings, directory levels and text files, recording each request. */
function serveFiles(requests: string[] = [], files: string[] = ["README.md"]) {
  mockFetch((url) => {
    requests.push(url);
    if (url.includes("/files/tree")) return Response.json({ entries: [{ name: "src", type: "directory" }] });
    if (url.includes("/files/content")) return fileResponse(`content of ${url}`);
    return Response.json({ files });
  });
  return requests;
}

afterEach(() => restoreFetch());

describe("FileBrowserStore opening", () => {
  test("names its source's node when the viewed session is on another node", () => {
    serveFiles();
    let viewed: typeof source | null = source;
    const { store, client } = browser({ viewedSource: () => viewed });
    client.fireMessage({ type: "node_updated", node: testNode("internal", "Internal") });

    store.open(source);
    expect(store.otherNode).toBeNull();

    store.open({ nodeId: "internal", path: "/home/will/scratch" }, { path: "report.html" });
    expect(store.otherNode).toBe("Internal");

    viewed = null;
    expect(store.otherNode).toBeNull();
  });

  test("opens at a file with its lines and tab, as a `file` view, and opens the tree to it", async () => {
    const requests = serveFiles();
    const { store } = browser();

    store.open(source, { path: "src/components/app.ts", startLine: 3, endLine: 5, mode: "preview" });
    await settle();

    expect(store.browserOpen).toBe(true);
    expect(store.view).toEqual({ view: "file", source, path: "src/components/app.ts", startLine: 3, endLine: 5, mode: "preview" });
    expect([...store.expandedDirs]).toEqual([".", "src", "src/components"]);
    expect(requests.toSorted()).toEqual([
      "/api/nodes/node-a/files/tree?root=%2Fwork%2Fproject&path=.",
      "/api/nodes/node-a/files/tree?root=%2Fwork%2Fproject&path=src",
      "/api/nodes/node-a/files/tree?root=%2Fwork%2Fproject&path=src%2Fcomponents",
    ]);
  });

  test("closing keeps what it loaded, and opening it again without a file keeps its view and reads nothing", async () => {
    const requests = serveFiles();
    const { store } = browser();
    store.open(source, { path: "README.md" });
    await settle();
    const before = requests.length;
    const view = store.view;

    store.close();
    store.open(source);
    await settle();

    expect(store.browserOpen).toBe(true);
    expect(store.view).toBe(view);
    expect(store.directoryEntries.has(".")).toBe(true);
    expect(requests).toHaveLength(before);
  });

  test("opening a file again gives a new view, which its viewer reads again and reveals the lines of", () => {
    serveFiles();
    const { store } = browser();
    store.open(source, { path: "README.md", startLine: 2, endLine: 2 });
    const view = store.view;

    store.open(source, { path: "README.md", startLine: 2, endLine: 2 });

    expect(store.view).toEqual({ view: "file", source, path: "README.md", startLine: 2, endLine: 2 });
    expect(store.view).not.toBe(view);
  });

  test("another source starts over and drops the old source's responses", async () => {
    const oldTree = deferred();
    let oldTreeAsked = false;
    mockFetch((url) => {
      if (url === "/api/nodes/node-a/files/tree?root=%2Fwork%2Fproject&path=." && !oldTreeAsked) {
        oldTreeAsked = true;
        return oldTree.promise;
      }
      if (url.includes("/files/tree")) return Response.json({ entries: [{ name: "other.ts", type: "file" }] });
      return fileResponse("text");
    });
    const { store, sessions } = browser();
    sessions.set("other", { projectId: 1, placement: { available: true, removed: false, nodeId: "node-b", nodeName: "B", path: "/work/project" } });
    store.open(source, { path: "README.md" });
    store.setQuery("read");

    store.open({ nodeId: "node-b", path: "/work/project" });
    oldTree.resolve(Response.json({ entries: [{ name: "stale.ts", type: "file" }] }));
    await settle();

    expect(store.path).toBeNull();
    expect(store.query).toBe("");
    expect(store.directoryEntries.get(".")).toEqual([{ name: "other.ts", type: "file" }]);
  });
});

describe("FileBrowserStore directory tree", () => {
  test("lists a directory once", async () => {
    const requests = serveFiles();
    const { store } = browser();
    store.open(source);
    await settle();

    await store.fetchDirectory(".");

    expect(requests.filter((url) => url.includes("/files/tree"))).toEqual(["/api/nodes/node-a/files/tree?root=%2Fwork%2Fproject&path=."]);
    expect(store.directoryEntries.get(".")).toEqual([{ name: "src", type: "directory" }]);
  });

  test("reports a directory that fails to load", async () => {
    mockFetch(() => { throw new Error("Network error"); });
    const { store } = browser();
    store.open(source);
    await settle();

    expect(store.treeError).toBe("Failed to load directory");
    expect(store.treeLoading.has(".")).toBe(false);
  });

  test("toggling a directory expands and collapses it", async () => {
    serveFiles();
    const { store } = browser();
    store.open(source);

    await store.toggleDirectory("src");
    expect(store.expandedDirs.has("src")).toBe(true);
    expect(store.directoryEntries.get("src")).toEqual([{ name: "src", type: "directory" }]);

    await store.toggleDirectory("src");
    expect(store.expandedDirs.has("src")).toBe(false);
  });

  test("lists its directories again when its source's files may have changed", async () => {
    const requests = serveFiles();
    const { client, store } = browser();
    store.open(source, { path: "README.md" });
    await settle();
    requests.length = 0;

    jest.useFakeTimers();
    client.fireMessage({ type: "event", sessionId: "placed", projectId: 1, seq: 1, emittedAt: 0, event: { type: "agent_end" } });
    jest.advanceTimersByTime(500);
    jest.useRealTimers();
    await settle();

    expect(requests).toEqual(["/api/nodes/node-a/files/tree?root=%2Fwork%2Fproject&path=."]);
  });
});

describe("FileBrowserStore search", () => {
  async function searching(files: string[]): Promise<FileBrowserStore> {
    serveFiles([], files);
    const { store } = browser();
    store.openSearch(source);
    void store.listing;
    await settle();
    return store;
  }

  test("fuzzy matches paths, preferring tight basename matches", async () => {
    const store = await searching([
      "src/scripting/api-scheme-formatter.ts",
      "src/components/formatted-output.ts",
      "src/utils/format.ts",
      "README.md",
    ]);

    store.setQuery("format");

    expect(store.results[0]).toBe("src/utils/format.ts");
    expect(store.results).not.toContain("README.md");
    store.setQuery("zzz");
    expect(store.results).toEqual([]);
  });

  test("still matches across the path when the basename does not match", async () => {
    const store = await searching(["src/utils/helpers.ts", "src/components/widget.ts"]);

    store.setQuery("shelp");

    expect(store.results).toEqual(["src/utils/helpers.ts"]);
  });

  test("lists the first 50 files for an empty query, and opening the search again clears its query", async () => {
    const store = await searching(Array.from({ length: 100 }, (_, i) => `file${i}.ts`));
    store.setQuery("file1");

    store.closeSearch();
    store.openSearch(source);

    expect(store.query).toBe("");
    expect(store.results).toHaveLength(50);
  });

  test("lists nothing, without an error, while the source's node is offline", async () => {
    mockFetch(() => Response.json({ error: "Node not connected" }, { status: 503 }));
    const { store } = browser({ available: false });

    store.openSearch(source);
    void store.listing;
    await settle();

    expect(store.results).toEqual([]);
    expect(store.listing.error).toBeNull();
  });

  test("choosing a result closes the search and shows the file in the browser", async () => {
    const store = await searching(["README.md"]);

    store.select("README.md");

    expect(store.searchOpen).toBe(false);
    expect(store.browserOpen).toBe(true);
    expect(store.path).toBe("README.md");
  });
});

function someFiles(...names: string[]) {
  return names.map(name => new File([name], name));
}

describe("FileBrowserStore upload", () => {
  test("uploads into the open file's folder of its source, shows its progress, then lists its directories again", async () => {
    const requests = serveFiles();
    const xhr = fakeXhr(({ files: names }) => ({ status: 200, body: { uploaded: names } }));
    try {
      const { store } = browser();
      store.open(source, { path: "docs/plan.md" });
      await settle();
      requests.length = 0;
      const progress: Array<number | null> = [];
      store.subscribe(() => progress.push(store.uploadProgress));

      expect(store.uploadFolder).toBe("docs");
      const result = await store.upload(someFiles("a.txt", "b.png"));

      expect(result).toEqual({ uploaded: ["a.txt", "b.png"] });
      expect(xhr.uploads).toEqual([{ method: "POST", url: "/api/nodes/node-a/files/upload?root=%2Fwork%2Fproject&path=docs", files: ["a.txt", "b.png"] }]);
      expect(progress).toContain(50);
      expect(store.uploadProgress).toBeNull();
      await settle();
      expect(requests).toContain("/api/nodes/node-a/files/tree?root=%2Fwork%2Fproject&path=.");
    } finally {
      xhr.restore();
    }
  });

  test("with no file open, uploads into the checkout's root", async () => {
    serveFiles();
    const xhr = fakeXhr(({ files: names }) => ({ status: 200, body: { uploaded: names } }));
    try {
      const { store } = browser();
      store.open(source);

      expect(store.uploadFolder).toBe(".");
      await store.upload(someFiles("a.txt"));

      expect(xhr.uploads.map(upload => upload.url)).toEqual(["/api/nodes/node-a/files/upload?root=%2Fwork%2Fproject"]);
    } finally {
      xhr.restore();
    }
  });

  test("a refused upload gives the server's reason", async () => {
    serveFiles();
    const xhr = fakeXhr(() => ({ status: 400, body: { error: "Path escapes the checkout" } }));
    try {
      const { store } = browser();
      store.open(source);

      expect(await store.upload(someFiles("a.txt"))).toEqual({ error: "Path escapes the checkout" });
      expect(store.uploadProgress).toBeNull();
    } finally {
      xhr.restore();
    }
  });
});
