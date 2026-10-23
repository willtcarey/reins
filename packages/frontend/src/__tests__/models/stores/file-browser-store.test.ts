import { afterEach, describe, expect, jest, test } from "bun:test";
import { FileBrowserStore } from "../../../models/stores/file-browser-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";

const source = { nodeId: "node-a", path: "/work/project" };

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function browser(options: { available?: boolean } = {}) {
  const sdk = testSdk({ source, projectId: 1, ...options });
  return { ...sdk, store: new FileBrowserStore(sdk.reins) };
}

/** A project file server: listings, directory levels and text files, recording each request. */
function serveFiles(requests: string[] = [], files: string[] = ["README.md"]) {
  mockFetch((url) => {
    requests.push(url);
    if (url.includes("/files/tree")) return Response.json({ entries: [{ name: "src", type: "directory" }] });
    if (url.includes("/files/content")) return new Response(`content of ${url}`, { headers: { "content-type": "text/plain" } });
    return Response.json({ files });
  });
  return requests;
}

afterEach(() => restoreFetch());

describe("FileBrowserStore opening", () => {
  test("opens at a file with its lines and tab, as a `file` view, and opens the tree to it", async () => {
    const requests = serveFiles();
    const { store } = browser();

    store.open(source, { path: "src/components/app.ts", startLine: 3, endLine: 5, mode: "preview" });
    await settle();

    expect(store.browserOpen).toBe(true);
    expect(store.view).toEqual({ view: "file", source, path: "src/components/app.ts", startLine: 3, endLine: 5, mode: "preview" });
    expect([...store.expandedDirs]).toEqual([".", "src", "src/components"]);
    expect(requests.toSorted()).toEqual([
      "/api/projects/1/files/tree?path=.",
      "/api/projects/1/files/tree?path=src",
      "/api/projects/1/files/tree?path=src%2Fcomponents",
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
      if (url === "/api/projects/1/files/tree?path=." && !oldTreeAsked) {
        oldTreeAsked = true;
        return oldTree.promise;
      }
      if (url.includes("/files/tree")) return Response.json({ entries: [{ name: "other.ts", type: "file" }] });
      return new Response("text", { headers: { "content-type": "text/plain" } });
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

    expect(requests.filter((url) => url.includes("/files/tree"))).toEqual(["/api/projects/1/files/tree?path=."]);
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

    expect(requests).toEqual(["/api/projects/1/files/tree?path=."]);
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

  test("lists nothing while the source's node is offline", async () => {
    const requests = serveFiles();
    const { store } = browser({ available: false });

    store.openSearch(source);
    await settle();

    expect(store.results).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("choosing a result closes the search and shows the file in the browser", async () => {
    const store = await searching(["README.md"]);

    store.select("README.md");

    expect(store.searchOpen).toBe(false);
    expect(store.browserOpen).toBe(true);
    expect(store.path).toBe("README.md");
  });
});
