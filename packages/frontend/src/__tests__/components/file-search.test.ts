import { afterEach, describe, expect, test } from "bun:test";
import { FileSearch } from "../../components/file-search.js";
import { FileModel } from "../../models/stores/file-model.js";
import { clickButton } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

async function openSearch(files: string[]): Promise<FileSearch> {
  mockFetch(() => Response.json({ files }));
  const model = new FileModel();
  model.setSource({ projectId: 5, nodeId: "node", checkoutPath: "/work", available: true });
  await model.loadFiles();
  const search = new FileSearch();
  search.store = model;
  search.open = true;
  search.willUpdate(new Map([["store", undefined]]));
  Reflect.get(search, "_refilter").call(search);
  return search;
}

afterEach(() => restoreFetch());

describe("FileSearch", () => {
  test("opens a chosen file in the file browser", async () => {
    const search = await openSearch(["README.md", "src/app.ts"]);
    const opened: unknown[] = [];
    search.addEventListener("open-in-browser", (event) => opened.push(event.detail));

    Reflect.get(search, "handleConfirm").call(search, new CustomEvent("confirm", { detail: 1 }));

    expect(opened).toEqual([{ projectId: 5, path: "src/app.ts" }]);
  });

  test("opens a file in the Inspector from its row and closes", async () => {
    const search = await openSearch(["README.md", "src/app.ts"]);
    const opened: unknown[] = [];
    let closes = 0;
    search.addEventListener("open-view", (event) => opened.push(event.detail));
    search.addEventListener("file-search-close", () => { closes += 1; });

    const renderAction = Reflect.get(search, "renderItemAction");
    clickButton(renderAction(1), "Open src/app.ts in Inspector");

    expect(opened).toEqual([{ view: { view: "file", path: "src/app.ts" }, options: { in: "inspector" } }]);
    expect(closes).toBe(1);
  });
});
