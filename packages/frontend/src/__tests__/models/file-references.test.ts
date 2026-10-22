import { afterEach, describe, expect, jest, test } from "bun:test";
import { FileReferenceIndex, registerFileReferences } from "../../models/file-references.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { placedHost } from "../helpers/reins-sdk.js";

const files = [
  "README.md",
  "docs/TODO.md",
  "docs/plans/workspace-inspector.md",
  "packages/frontend/src/components/app.ts",
  "packages/frontend/src/components/chat-message.ts",
  "packages/backend/src/app.ts",
];
const index = new FileReferenceIndex(files, "/home/will/Workspaces/reins");

describe("FileReferenceIndex.resolve", () => {
  test("resolves a full relative path exactly", () => {
    expect(index.resolve("packages/frontend/src/components/chat-message.ts")).toEqual({ path: "packages/frontend/src/components/chat-message.ts" });
    expect(index.resolve("./docs/TODO.md")).toEqual({ path: "docs/TODO.md" });
    expect(index.resolve("frontend/src/components/chat-message.ts")).toBeNull();
    expect(index.resolve("docs/missing.md")).toBeNull();
  });

  test("resolves an absolute path inside the checkout, and nothing outside it", () => {
    expect(index.resolve("/home/will/Workspaces/reins/docs/TODO.md")).toEqual({ path: "docs/TODO.md" });
    expect(index.resolve("/home/will/Workspaces/other/docs/TODO.md")).toBeNull();
    expect(index.resolve("/docs/TODO.md")).toBeNull();
  });

  test("rejects traversal", () => {
    expect(index.resolve("docs/plans/../TODO.md")).toBeNull();
    expect(index.resolve("/home/will/Workspaces/reins/../reins/docs/TODO.md")).toBeNull();
  });

  test("resolves a bare basename only when one file has it", () => {
    expect(index.resolve("chat-message.ts")).toEqual({ path: "packages/frontend/src/components/chat-message.ts" });
    expect(index.resolve("workspace-inspector.md")).toEqual({ path: "docs/plans/workspace-inspector.md" });
    expect(index.resolve("app.ts")).toBeNull();
  });

  test("turns line and line-range suffixes into lines", () => {
    expect(index.resolve("chat-message.ts:127")).toEqual({ path: "packages/frontend/src/components/chat-message.ts", startLine: 127 });
    expect(index.resolve("README.md:12:5")).toEqual({ path: "README.md", startLine: 12 });
    expect(index.resolve("README.md:120-135")).toEqual({ path: "README.md", startLine: 120, endLine: 135 });
    expect(index.resolve("packages/frontend/src/components/app.ts#L120-L135")).toEqual({ path: "packages/frontend/src/components/app.ts", startLine: 120, endLine: 135 });
    expect(index.resolve("README.md#L7")).toEqual({ path: "README.md", startLine: 7 });
  });

  test("leaves URLs alone", () => {
    expect(index.resolve("https://github.com/acme/reins/blob/main/README.md")).toBeNull();
  });
});

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const source = { nodeId: "node", path: "/home/will/Workspaces/reins" };

/** File references registered with a host whose source lists `files`, once the listing has loaded. */
async function referencesHost() {
  mockFetch(() => Response.json({ files }));
  const placed = placedHost({ source });
  registerFileReferences(placed.sdk);
  placed.host.decorations(source)?.segments("README.md");
  await settle();
  return placed;
}

afterEach(() => restoreFetch());

describe("file references as a message decorator", () => {

  test("finds references in prose, leaving surrounding punctuation in the text", async () => {
    const { host } = await referencesHost();
    expect(host.decorations(source)?.segments("See (docs/TODO.md:4), then README.md.")).toEqual([
      "See (",
      { text: "docs/TODO.md:4", view: { view: "file", path: "docs/TODO.md", startLine: 4 }, label: "Open docs/TODO.md:4 in the Inspector" },
      "), then ",
      { text: "README.md", view: { view: "file", path: "README.md" }, label: "Open README.md in the Inspector" },
      ".",
    ]);
  });

  test("takes the longest reference a word holds", async () => {
    const { host } = await referencesHost();
    expect(host.decorations(source)?.segments("at /home/will/Workspaces/reins/packages/frontend/src/components/app.ts#L3-L9:")).toEqual([
      "at ",
      {
        text: "/home/will/Workspaces/reins/packages/frontend/src/components/app.ts#L3-L9",
        view: { view: "file", path: "packages/frontend/src/components/app.ts", startLine: 3, endLine: 9 },
        label: "Open packages/frontend/src/components/app.ts:3-9 in the Inspector",
      },
      ":",
    ]);
  });

  test("leaves unresolved, ambiguous and URL text unchanged", async () => {
    const { host } = await referencesHost();
    const text = "app.ts is ambiguous, missing.md is missing, https://example.com/README.md is a URL";
    expect(host.decorations(source)?.segments(text)).toEqual([text]);
  });

  test("resolves a whole inline-code span", async () => {
    const { host } = await referencesHost();
    const decorations = host.decorations(source);
    expect(decorations?.code(" README.md:2 ")).toEqual({ view: { view: "file", path: "README.md", startLine: 2 }, label: "Open README.md:2 in the Inspector" });
    expect(decorations?.code("README.md and more")).toBeNull();
  });

  test("decorates once the source's listing arrives, and keeps the same decorations while it is unchanged", async () => {
    mockFetch(() => Response.json({ files: ["README.md"] }));
    const { host, client } = placedHost({ source });
    registerFileReferences(host.sdk);
    let changes = 0;
    host.subscribe(() => { changes += 1; });

    const before = host.decorations(source);
    expect(before?.segments("See README.md")).toEqual(["See README.md"]);
    await settle();
    const after = host.decorations(source);

    expect(changes).toBe(1);
    expect(after).not.toBe(before);
    expect(after?.segments("See /home/will/Workspaces/reins/README.md")).toEqual([
      "See ",
      { text: "/home/will/Workspaces/reins/README.md", view: { view: "file", path: "README.md" }, label: "Open README.md in the Inspector" },
    ]);
    jest.useFakeTimers();
    client.fireMessage({ type: "event", sessionId: "placed", projectId: 1, seq: 1, emittedAt: 0, event: { type: "agent_end" } });
    jest.advanceTimersByTime(500);
    jest.useRealTimers();
    await settle();
    expect(host.decorations({ ...source })).toBe(after);
  });

  test("decorates nothing while the source's node is offline", async () => {
    mockFetch(() => Response.json({ files: ["README.md"] }));
    const { host, sessions } = placedHost({ source });
    registerFileReferences(host.sdk);
    host.decorations(source)?.segments("README.md");
    await settle();

    sessions.set("placed", { placement: { available: false, removed: false, nodeId: "node", nodeName: "Node", path: source.path } });

    expect(host.decorations(source)?.segments("README.md")).toEqual(["README.md"]);
  });
});
