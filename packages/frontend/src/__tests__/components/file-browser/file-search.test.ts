import { afterEach, describe, expect, test } from "bun:test";
import { FileSearch } from "../../../components/file-browser/file-search.js";
import { FileBrowserStore } from "../../../models/stores/file-browser-store.js";
import { ProjectFiles } from "../../../models/stores/project-files.js";
import { SessionCache } from "../../../models/stores/session-cache.js";
import { clickButton } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { StubClient } from "../../helpers/stub-client.js";

const source = { projectId: 5, nodeId: "node", path: "/work", available: true };

async function openSearch(files: string[]): Promise<{ search: FileSearch; store: FileBrowserStore }> {
  mockFetch((url) => (url.endsWith("/files")
    ? Response.json({ files })
    : new Response("text", { headers: { "content-type": "text/plain" } })));
  const store = new FileBrowserStore(new ProjectFiles(new StubClient(), new SessionCache()));
  store.openSearch(source);
  void store.listing;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const search = new FileSearch();
  search.store = store;
  return { search, store };
}

afterEach(() => restoreFetch());

describe("FileSearch", () => {
  test("shows a chosen file in the file browser", async () => {
    const { search, store } = await openSearch(["README.md", "src/app.ts"]);

    Reflect.get(search, "handleConfirm").call(search, new CustomEvent("confirm", { detail: 1 }));

    expect(store.searchOpen).toBe(false);
    expect(store.browserOpen).toBe(true);
    expect(store.path).toBe("src/app.ts");
  });

  test("opens a file in the Inspector from its row and closes", async () => {
    const { search, store } = await openSearch(["README.md", "src/app.ts"]);
    const opened: unknown[] = [];
    search.addEventListener("open-view", (event) => opened.push(event.detail));

    const renderAction = Reflect.get(search, "renderItemAction");
    clickButton(renderAction(1), "Open src/app.ts in Inspector");

    expect(opened).toEqual([{ view: { view: "file", path: "src/app.ts" }, options: { in: "inspector" }, projectId: 5 }]);
    expect(store.searchOpen).toBe(false);
  });
});
