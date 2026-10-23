import { afterEach, describe, expect, jest, test } from "bun:test";
import { LitElement } from "lit";
import { FileReferenceIndex, referenceMount, registerFileReferences } from "../../models/file-references.js";
import type { ViewOf } from "../../reins-sdk/contract.js";
import type { DecoratedSegment } from "../../reins-sdk/decorations.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { testSdk } from "../helpers/reins-sdk.js";
import { testElement } from "../helpers/test-dom.js";

const files = [
  "README.md",
  "docs/TODO.md",
  "docs/plans/workspace-inspector.md",
  "packages/frontend/src/components/app.ts",
  "packages/frontend/src/components/chat-message.ts",
  "packages/backend/src/app.ts",
];
const source = { nodeId: "node", path: "/home/will/Workspaces/reins" };
const index = new FileReferenceIndex(files, source);

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

/** File references registered with an SDK whose source lists `files`, once the listing has loaded. */
async function registeredReferences() {
  mockFetch(() => Response.json({ files }));
  const sdk = testSdk({ source });
  registerFileReferences(sdk.reins);
  sdk.decorators.decorations(source)?.segments("README.md");
  await settle();
  return sdk;
}

/** Decorated segments as text and each piece's reference, which must be a `file-reference` view of the source. */
function pieces(segments: DecoratedSegment[] | undefined) {
  return segments?.map((segment) => {
    if (typeof segment === "string") return segment;
    if (segment.view.view !== "file-reference") throw new Error("Expected a file-reference view");
    const { view: _, source: viewed, ...reference } = segment.view;
    expect(viewed).toEqual(source);
    return { text: segment.context.text, reference };
  });
}

afterEach(() => restoreFetch());

describe("file references as a message decorator", () => {

  test("finds references in prose, leaving surrounding punctuation in the text", async () => {
    const { decorators } = await registeredReferences();
    expect(pieces(decorators.decorations(source)?.segments("See (docs/TODO.md:4), then README.md."))).toEqual([
      "See (",
      { text: "docs/TODO.md:4", reference: { path: "docs/TODO.md", startLine: 4 } },
      "), then ",
      { text: "README.md", reference: { path: "README.md" } },
      ".",
    ]);
  });

  test("takes the longest reference a word holds", async () => {
    const { decorators } = await registeredReferences();
    expect(pieces(decorators.decorations(source)?.segments("at /home/will/Workspaces/reins/packages/frontend/src/components/app.ts#L3-L9:"))).toEqual([
      "at ",
      {
        text: "/home/will/Workspaces/reins/packages/frontend/src/components/app.ts#L3-L9",
        reference: { path: "packages/frontend/src/components/app.ts", startLine: 3, endLine: 9 },
      },
      ":",
    ]);
  });

  test("leaves unresolved, ambiguous and URL text unchanged", async () => {
    const { decorators } = await registeredReferences();
    const text = "app.ts is ambiguous, missing.md is missing, https://example.com/README.md is a URL";
    expect(decorators.decorations(source)?.segments(text)).toEqual([text]);
  });

  test("resolves a whole inline-code span", async () => {
    const { decorators } = await registeredReferences();
    const decorations = decorators.decorations(source);
    expect(decorations?.code(" README.md:2 ")?.view).toEqual({ view: "file-reference", source, path: "README.md", startLine: 2 });
    expect(decorations?.code("README.md and more")).toBeNull();
  });

  test("decorates once the source's listing arrives, and keeps the same decorations while it is unchanged", async () => {
    mockFetch(() => Response.json({ files: ["README.md"] }));
    const { reins, decorators, client } = testSdk({ source });
    registerFileReferences(reins);
    let changes = 0;
    decorators.subscribe(() => { changes += 1; });

    const before = decorators.decorations(source);
    expect(before?.segments("See README.md")).toEqual(["See README.md"]);
    await settle();
    const after = decorators.decorations(source);

    expect(changes).toBe(1);
    expect(after).not.toBe(before);
    expect(pieces(after?.segments("See /home/will/Workspaces/reins/README.md"))).toEqual([
      "See ",
      { text: "/home/will/Workspaces/reins/README.md", reference: { path: "README.md" } },
    ]);
    jest.useFakeTimers();
    client.fireMessage({ type: "event", sessionId: "placed", projectId: 1, seq: 1, emittedAt: 0, event: { type: "agent_end" } });
    jest.advanceTimersByTime(500);
    jest.useRealTimers();
    await settle();
    expect(decorators.decorations({ ...source })).toBe(after);
  });

  test("decorates nothing while the source's node is offline", async () => {
    mockFetch(() => Response.json({ files: ["README.md"] }));
    const { reins, decorators, sessions } = testSdk({ source });
    registerFileReferences(reins);
    decorators.decorations(source)?.segments("README.md");
    await settle();

    sessions.set("placed", { placement: { available: false, removed: false, nodeId: "node", nodeName: "Node", path: source.path } });

    expect(decorators.decorations(source)?.segments("README.md")).toEqual(["README.md"]);
  });
});

describe("the file-reference view", () => {
  /** A reference shown inline in place of `original`, and the control it drew. */
  function mounted(sdk: ReturnType<typeof testSdk>, view: ViewOf<"file-reference">, original: HTMLElement) {
    const target = testElement();
    referenceMount(sdk.reins.workspace)(target, view, { source, text: "", code: true, original: () => original });
    const control = target.childNodes[0];
    if (!(control instanceof LitElement)) throw new Error("Expected a control");
    return control;
  }

  test("draws the reference's original text as a control, labelled with what it opens", () => {
    const original = testElement();

    const control = mounted(testSdk({ source }), { view: "file-reference", source, path: "docs/TODO.md", startLine: 3, endLine: 5 }, original);

    expect(control.className).toBe("file-reference");
    expect(control.getAttribute("role")).toBe("button");
    expect(control.getAttribute("tabindex")).toBe("0");
    expect(control.title).toBe("Open docs/TODO.md:3-5 in the Inspector");
    expect([...control.childNodes]).toEqual([original]);
  });

  test("opens its file of its source in the Inspector on a click, Enter or Space", () => {
    const sdk = testSdk({ source });
    const control = mounted(sdk, { view: "file-reference", source, path: "README.md", startLine: 4 }, testElement());

    const click = new Event("click", { cancelable: true });
    control.dispatchEvent(click);
    control.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" }));
    control.dispatchEvent(Object.assign(new Event("keydown"), { key: " " }));
    control.dispatchEvent(Object.assign(new Event("keydown"), { key: "a" }));

    expect(click.defaultPrevented).toBe(true);
    expect(sdk.opened).toEqual(Array.from({ length: 3 }, () => ({ view: { view: "file", source, path: "README.md", startLine: 4 }, container: "inspector" })));
  });
});
