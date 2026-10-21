import { afterEach, describe, expect, test } from "bun:test";
import { MessageDecorations, messageDecorations, type MessageDecorator } from "../../models/message-decorations.js";
import { ProjectFiles, type FileSource } from "../../models/stores/project-files.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { StubClient } from "../helpers/stub-client.js";

/** Decorates every occurrence of a word with a view of the file it names. */
function wordDecorator(word: string): MessageDecorator {
  const decoration = { view: { view: "file" as const, path: `${word}.md` }, title: word };
  return {
    find: (text) => [...text.matchAll(new RegExp(word, "g"))].map((match) => ({ start: match.index, end: match.index + word.length, ...decoration })),
    resolveCode: (code) => (code === word ? decoration : null),
  };
}

const source: FileSource = { projectId: 1, nodeId: "node", path: "/work", available: true };

afterEach(() => restoreFetch());

describe("MessageDecorations", () => {
  test("splits prose by every decorator's targets, an earlier decorator winning an overlap", () => {
    const decorations = new MessageDecorations([wordDecorator("plan"), wordDecorator("planning"), wordDecorator("notes")]);

    expect(decorations.segments("planning notes")).toEqual([
      { text: "plan", view: { view: "file", path: "plan.md" }, title: "plan" },
      "ning ",
      { text: "notes", view: { view: "file", path: "notes.md" }, title: "notes" },
    ]);
  });

  test("leaves fenced code blocks of plain text undecorated", () => {
    const decorations = new MessageDecorations([wordDecorator("plan")]);

    expect(decorations.plainText("Edit plan:\n```\ncat plan\n```\ndone")).toEqual([
      "Edit ",
      { text: "plan", view: { view: "file", path: "plan.md" }, title: "plan" },
      ":\n```\ncat plan\n```\ndone",
    ]);
  });

  test("resolves inline code with the first decorator that has it", () => {
    const decorations = new MessageDecorations([wordDecorator("plan"), wordDecorator("notes")]);

    expect(decorations.code("notes")?.view).toEqual({ view: "file", path: "notes.md" });
    expect(decorations.code("other")).toBeNull();
  });
});

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("messageDecorations", () => {
  test("decorates files once the source's listing arrives, keeping the same decorations while it is unchanged", async () => {
    mockFetch(() => Response.json({ files: ["README.md"] }));
    const files = new ProjectFiles(new StubClient(), new SessionCache());

    expect(messageDecorations({ files, source })).toBeNull();
    await settle();
    const decorations = messageDecorations({ files, source });

    expect(decorations?.segments("See /work/README.md")).toEqual([
      "See ",
      { text: "/work/README.md", view: { view: "file", path: "README.md" }, title: "Open README.md in the Inspector" },
    ]);
    expect(messageDecorations({ files, source: { ...source } })).toBe(decorations);
  });

  test("decorates nothing while the source's node is offline", async () => {
    mockFetch(() => Response.json({ files: ["README.md"] }));
    const files = new ProjectFiles(new StubClient(), new SessionCache());
    files.listing(source);
    await settle();

    expect(messageDecorations({ files, source: { ...source, available: false } })).toBeNull();
    expect(messageDecorations({ files, source: null })).toBeNull();
  });
});
