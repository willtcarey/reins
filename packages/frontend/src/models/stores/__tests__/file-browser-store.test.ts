import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { FileBrowserStore, type DirEntry } from "../file-browser-store.js";
import {
  mockFetch,
  restoreFetch,
} from "../../../__tests__/helpers/mock-fetch.js";

describe("FileBrowserStore tree state", () => {
  let store: FileBrowserStore;

  function setupFetch(response: { entries: DirEntry[] }, ok = true) {
    mockFetch(
      () =>
        new Response(JSON.stringify(response), {
          status: ok ? 200 : 500,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  beforeEach(() => {
    store = new FileBrowserStore();
    store.projectId = 1;
  });

  afterEach(() => {
    restoreFetch();
  });

  // ---- fetchDirectory -------------------------------------------------------

  test("fetchDirectory fetches from the correct URL and caches results", async () => {
    const entries: DirEntry[] = [
      { name: "src", type: "directory" },
      { name: "README.md", type: "file" },
    ];
    setupFetch({ entries });

    await store.fetchDirectory(".");

    expect(store.directoryEntries.get(".")).toEqual(entries);
  });

  test("fetchDirectory skips fetch if directory is already cached", async () => {
    let callCount = 0;
    mockFetch(() => {
      callCount++;
      return new Response(JSON.stringify({ entries: [] }), {
        headers: { "content-type": "application/json" },
      });
    });

    await store.fetchDirectory("src");
    await store.fetchDirectory("src");

    expect(callCount).toBe(1);
  });

  test("fetchDirectory sets and clears treeLoading during fetch", async () => {
    const loadingStates: boolean[] = [];

    let resolveFetch!: () => void;
    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = () =>
            resolve(
              new Response(JSON.stringify({ entries: [] }), {
                headers: { "content-type": "application/json" },
              }),
            );
        }),
    );

    const promise = store.fetchDirectory("src");
    loadingStates.push(store.treeLoading.has("src"));

    resolveFetch();
    await promise;
    loadingStates.push(store.treeLoading.has("src"));

    expect(loadingStates).toEqual([true, false]);
  });

  test("fetchDirectory sets treeError on fetch failure", async () => {
    mockFetch(() => {
      throw new Error("Network error");
    });

    await store.fetchDirectory("src");

    expect(store.treeError).toBe("Failed to load directory");
  });

  test("fetchDirectory calls notify (subscribe listener fires)", async () => {
    setupFetch({ entries: [] });
    const listener = mock(() => {});
    store.subscribe(listener);

    await store.fetchDirectory(".");

    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  // ---- toggleDirectory ------------------------------------------------------

  test("toggleDirectory adds to expandedDirs and triggers fetch for uncached dirs", async () => {
    const entries: DirEntry[] = [{ name: "index.ts", type: "file" }];
    setupFetch({ entries });

    await store.toggleDirectory("src");

    expect(store.expandedDirs.has("src")).toBe(true);
    expect(store.directoryEntries.get("src")).toEqual(entries);
  });

  test("toggleDirectory removes from expandedDirs on second call (collapse)", async () => {
    setupFetch({ entries: [] });

    await store.toggleDirectory("src");
    expect(store.expandedDirs.has("src")).toBe(true);

    await store.toggleDirectory("src");
    expect(store.expandedDirs.has("src")).toBe(false);
  });

  // ---- expandToPath ---------------------------------------------------------

  test("expandToPath expands all ancestor directories", async () => {
    setupFetch({ entries: [] });

    await store.expandToPath("src/components/app.ts");

    expect(store.expandedDirs.has(".")).toBe(true);
    expect(store.expandedDirs.has("src")).toBe(true);
    expect(store.expandedDirs.has("src/components")).toBe(true);
  });

  test("expandToPath fetches uncached ancestor directories", async () => {
    const fetchedUrls: string[] = [];
    mockFetch((url) => {
      fetchedUrls.push(url);
      return new Response(JSON.stringify({ entries: [] }), {
        headers: { "content-type": "application/json" },
      });
    });

    await store.expandToPath("src/components/app.ts");

    expect(fetchedUrls).toContain("/api/projects/1/files/tree?path=.");
    expect(fetchedUrls).toContain("/api/projects/1/files/tree?path=src");
    expect(fetchedUrls).toContain(
      "/api/projects/1/files/tree?path=src%2Fcomponents",
    );
  });

  // ---- reset ----------------------------------------------------------------

  test("reset clears all tree state", async () => {
    setupFetch({ entries: [{ name: "a", type: "file" }] });

    await store.fetchDirectory(".");
    await store.toggleDirectory("src");
    store.treeError = "some error";

    store.reset();

    expect(store.directoryEntries.size).toBe(0);
    expect(store.expandedDirs.size).toBe(0);
    expect(store.treeLoading.size).toBe(0);
    expect(store.treeError).toBeNull();
  });
});

// ---- selectFile: binary detection via content-type --------------------------

describe("FileBrowserStore selectFile binary detection", () => {
  let store: FileBrowserStore;
  let fetchCalls: string[];

  afterEach(() => {
    restoreFetch();
  });

  function setupStore(contentType: string, body: BodyInit = "data") {
    store = new FileBrowserStore();
    store.projectId = 1;
    fetchCalls = [];
    mockFetch((url) => {
      fetchCalls.push(String(url));
      if (String(url).includes("/files/content")) {
        return new Response(body, {
          status: 200,
          headers: { "content-type": contentType },
        });
      }
      return new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  test("detects image files as binary via content-type", async () => {
    setupStore("image/png", new Blob([new Uint8Array(64)]));
    await store.selectFile("assets/logo.png");

    expect(store.selectedFile).toBe("assets/logo.png");
    expect(store.isBinary).toBe(true);
    expect(store.contentLoading).toBe(false);
    const contentFetches = fetchCalls.filter((u) => u.includes("/files/content"));
    expect(contentFetches).toHaveLength(1);
  });

  test("detects PDF files as binary via content-type", async () => {
    setupStore("application/pdf", new Blob([new Uint8Array(128)]));
    await store.selectFile("docs/report.pdf");

    expect(store.selectedFile).toBe("docs/report.pdf");
    expect(store.isBinary).toBe(true);
    expect(store.contentLoading).toBe(false);
    const contentFetches = fetchCalls.filter((u) => u.includes("/files/content"));
    expect(contentFetches).toHaveLength(1);
  });

  test("contentUrl is set correctly for images", async () => {
    setupStore("image/png", new Blob([new Uint8Array(64)]));
    await store.selectFile("assets/logo.png");
    expect(store.contentUrl).toBe("/api/projects/1/files/content?path=assets%2Flogo.png");
  });

  test("fetches and reads content for text files", async () => {
    setupStore("text/plain", "hello world");
    await store.selectFile("src/index.ts");

    const contentFetches = fetchCalls.filter((u) => u.includes("/files/content"));
    expect(contentFetches).toHaveLength(1);
    expect(store.fileContent).toBe("hello world");
    expect(store.isBinary).toBe(false);
  });
});
