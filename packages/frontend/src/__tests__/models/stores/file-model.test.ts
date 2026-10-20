import { afterEach, describe, expect, test } from "bun:test";
import { FileModel, type FileSource } from "../../../models/stores/file-model.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

const source: FileSource = { projectId: 1, nodeId: "node-a", checkoutPath: "/work/project", available: true };

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

async function modelWithFiles(files: string[]): Promise<FileModel> {
  mockFetch(() => Response.json({ files }));
  const model = new FileModel();
  model.setSource(source);
  await model.loadFiles();
  return model;
}

afterEach(() => restoreFetch());

describe("FileModel inventory", () => {
  test("loads the source's file listing when given a source", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ files: ["README.md", "src/app.ts"] });
    });
    const model = new FileModel();

    model.setSource(source);
    await model.loadFiles();

    expect(requests).toEqual(["/api/projects/1/files"]);
    expect(model.files).toEqual(["README.md", "src/app.ts"]);
    expect(model.filesLoading).toBe(false);
  });

  test("does not load a listing while the source's node is offline, and loads it when the node returns", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ files: ["README.md"] });
    });
    const model = new FileModel();

    model.setSource({ ...source, available: false });
    await model.loadFiles();
    expect(requests).toEqual([]);

    model.setSource(source);
    await model.loadFiles();
    expect(requests).toEqual(["/api/projects/1/files"]);
    expect(model.files).toEqual(["README.md"]);
  });

  test("refresh reloads the listing and the loaded files", async () => {
    let version = 1;
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      if (url.includes("/files/content")) return new Response(`v${version}`, { headers: { "content-type": "text/plain" } });
      return Response.json({ files: [`file-${version}.ts`] });
    });
    const model = new FileModel();
    model.setSource(source);
    await model.loadFiles();
    await model.loadFile("README.md");

    version = 2;
    requests.length = 0;
    await model.refresh();

    expect(model.files).toEqual(["file-2.ts"]);
    expect(model.file("README.md")?.text).toBe("v2");
    expect(requests.toSorted()).toEqual(["/api/projects/1/files", "/api/projects/1/files/content?path=README.md"]);
  });
});

describe("FileModel scope", () => {
  test("another session in the same checkout keeps the loaded files", async () => {
    let requests = 0;
    mockFetch((url) => {
      requests += 1;
      if (url.includes("/files/content")) return new Response("hello", { headers: { "content-type": "text/plain" } });
      return Response.json({ files: ["README.md"] });
    });
    const model = new FileModel();
    model.setSource(source);
    await model.loadFiles();
    await model.loadFile("README.md");

    model.setSource({ ...source });
    await model.loadFiles();
    await model.loadFile("README.md");

    expect(requests).toBe(2);
    expect(model.files).toEqual(["README.md"]);
    expect(model.file("README.md")?.text).toBe("hello");
  });

  test("another project or source starts empty and ignores the old source's responses", async () => {
    const oldContent = deferred();
    const oldListing = deferred();
    mockFetch((url) => {
      if (url === "/api/projects/1/files") return oldListing.promise;
      if (url.startsWith("/api/projects/1/files/content")) return oldContent.promise;
      return Response.json({ files: ["other.ts"] });
    });
    const model = new FileModel();
    model.setSource(source);
    const listing = model.loadFiles();
    const content = model.loadFile("README.md");

    model.setSource({ ...source, nodeId: "node-b", checkoutPath: "/elsewhere", available: false });
    expect(model.file("README.md")).toBeUndefined();
    model.setSource({ projectId: 2, nodeId: "node-a", checkoutPath: "/work/other", available: true });
    await model.loadFiles();
    oldListing.resolve(Response.json({ files: ["stale.ts"] }));
    oldContent.resolve(new Response("stale", { headers: { "content-type": "text/plain" } }));
    await Promise.all([listing, content]);

    expect(model.projectId).toBe(2);
    expect(model.files).toEqual(["other.ts"]);
    expect(model.file("README.md")).toBeUndefined();
  });
});

describe("FileModel file content", () => {
  test("loads a text file once and shows it", async () => {
    let requests = 0;
    mockFetch(() => {
      requests += 1;
      return new Response("hello world", { headers: { "content-type": "text/plain" } });
    });
    const model = new FileModel();
    model.setSource({ ...source, available: false });

    const loading = model.loadFile("src/index.ts");
    expect(model.file("src/index.ts")?.loading).toBe(true);
    await loading;
    await model.loadFile("src/index.ts");

    expect(requests).toBe(1);
    expect(model.file("src/index.ts")).toEqual({ loading: false, text: "hello world", isBinary: false, error: null });
    expect(model.contentUrl("src/index.ts")).toBe("/api/projects/1/files/content?path=src%2Findex.ts");
  });

  test("a refreshing load keeps showing the file until its new content arrives", async () => {
    let next = deferred();
    mockFetch(() => next.promise);
    const model = new FileModel();
    model.setSource({ ...source, available: false });
    const first = model.loadFile("a.ts");
    next.resolve(new Response("old", { headers: { "content-type": "text/plain" } }));
    await first;

    next = deferred();
    const second = model.loadFile("a.ts", { refresh: true });
    expect(model.file("a.ts")).toEqual({ loading: false, text: "old", isBinary: false, error: null });
    next.resolve(new Response("new", { headers: { "content-type": "text/plain" } }));
    await second;

    expect(model.file("a.ts")?.text).toBe("new");
  });

  test("treats images and PDFs as binary", async () => {
    mockFetch((url) => new Response(new Blob([new Uint8Array(64)]), {
      headers: { "content-type": url.includes(".pdf") ? "application/pdf" : "image/png" },
    }));
    const model = new FileModel();
    model.setSource({ ...source, available: false });

    await model.loadFile("assets/logo.png");
    await model.loadFile("docs/report.pdf");

    expect(model.file("assets/logo.png")).toEqual({ loading: false, text: "Binary file (64 B)", isBinary: true, error: null });
    expect(model.file("docs/report.pdf")?.isBinary).toBe(true);
  });

  test("reports a missing file", async () => {
    mockFetch(() => Response.json({ error: "not found" }, { status: 404 }));
    const model = new FileModel();
    model.setSource({ ...source, available: false });

    await model.loadFile("gone.ts");

    expect(model.file("gone.ts")).toEqual({ loading: false, text: null, isBinary: false, error: "File not found" });
  });
});

describe("FileModel search", () => {
  test("fuzzy matches paths, preferring tight basename matches", async () => {
    const model = await modelWithFiles([
      "src/scripting/api-scheme-formatter.ts",
      "src/components/formatted-output.ts",
      "src/utils/format.ts",
      "README.md",
    ]);

    expect(model.filter("format")[0]).toBe("src/utils/format.ts");
    expect(model.filter("format")).not.toContain("README.md");
    expect(model.filter("zzz")).toEqual([]);
  });

  test("still matches across the path when the basename does not match", async () => {
    const model = await modelWithFiles(["src/utils/helpers.ts", "src/components/widget.ts"]);

    expect(model.filter("shelp")).toEqual(["src/utils/helpers.ts"]);
  });

  test("lists files up to the limit for an empty query", async () => {
    const model = await modelWithFiles(Array.from({ length: 100 }, (_, i) => `file${i}.ts`));

    expect(model.filter("", 10)).toHaveLength(10);
  });
});

describe("FileModel directory tree", () => {
  test("lists a directory once", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ entries: [{ name: "src", type: "directory" }, { name: "README.md", type: "file" }] });
    });
    const model = new FileModel();
    model.setSource({ ...source, available: false });

    await model.fetchDirectory(".");
    await model.fetchDirectory(".");

    expect(requests).toEqual(["/api/projects/1/files/tree?path=."]);
    expect(model.directoryEntries.get(".")).toEqual([{ name: "src", type: "directory" }, { name: "README.md", type: "file" }]);
  });

  test("reports a directory that fails to load", async () => {
    mockFetch(() => { throw new Error("Network error"); });
    const model = new FileModel();
    model.setSource({ ...source, available: false });

    await model.fetchDirectory("src");

    expect(model.treeError).toBe("Failed to load directory");
    expect(model.treeLoading.has("src")).toBe(false);
  });

  test("toggling a directory expands and collapses it", async () => {
    mockFetch(() => Response.json({ entries: [{ name: "index.ts", type: "file" }] }));
    const model = new FileModel();
    model.setSource({ ...source, available: false });

    await model.toggleDirectory("src");
    expect(model.expandedDirs.has("src")).toBe(true);
    expect(model.directoryEntries.get("src")).toEqual([{ name: "index.ts", type: "file" }]);

    await model.toggleDirectory("src");
    expect(model.expandedDirs.has("src")).toBe(false);
  });

  test("expanding to a path opens and lists its ancestors", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ entries: [] });
    });
    const model = new FileModel();
    model.setSource({ ...source, available: false });

    await model.expandToPath("src/components/app.ts");

    expect([...model.expandedDirs]).toEqual([".", "src", "src/components"]);
    expect(requests.toSorted()).toEqual([
      "/api/projects/1/files/tree?path=.",
      "/api/projects/1/files/tree?path=src",
      "/api/projects/1/files/tree?path=src%2Fcomponents",
    ]);
  });
});
