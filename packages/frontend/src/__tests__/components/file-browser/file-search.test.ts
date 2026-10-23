import { afterEach, describe, expect, test } from "bun:test";
import { FileSearch } from "../../../components/file-browser/file-search.js";
import { FileBrowserStore } from "../../../models/stores/file-browser-store.js";
import { clickButton } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";

const source = { nodeId: "node", path: "/work" };

async function openSearch(files: string[]) {
  mockFetch((url) => (url.endsWith("/files")
    ? Response.json({ files })
    : new Response("text", { headers: { "content-type": "text/plain" } })));
  const { reins, opened } = testSdk({ source, projectId: 5 });
  const store = new FileBrowserStore(reins);
  store.openSearch(source);
  void store.listing;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const search = new FileSearch();
  search.store = store;
  return { search, store, opened };
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
    const { search, store, opened } = await openSearch(["README.md", "src/app.ts"]);

    const renderAction = Reflect.get(search, "renderItemAction");
    clickButton(renderAction(1), "Open src/app.ts in Inspector");

    expect(opened).toEqual([{ view: { view: "file", source, path: "src/app.ts" }, container: "inspector" }]);
    expect(store.searchOpen).toBe(false);
  });
});
