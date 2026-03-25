/**
 * Tests for diff-file-card markdown preview behavior.
 *
 * Markdown rendered/preview state is internal to each card. The card owns:
 *  - rendered toggle (boolean)
 *  - fetch + cache of rendered HTML
 *  - loading state
 *  - file URL generation from projectId + branch
 *
 * No `toggle-rendered` event is emitted to the parent.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { DiffFileCard } from "../components/changes/diff-file-card.js";
import type { DiffFile } from "../models/changes/types.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";
import { getElementProperties } from "./helpers/lit-internals.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mdFile(path = "README.md"): DiffFile {
  return {
    path,
    additions: 1,
    removals: 0,
    hunks: [{
      header: "@@ -1,3 +1,4 @@",
      lines: [
        { type: "context", text: "# Hello", oldLine: 1, newLine: 1 },
        { type: "add", text: "world", newLine: 2 },
      ],
    }],
  };
}

/** Set up a card with projectId + branch so URL generation works. */
function cardWithProject(file?: DiffFile): DiffFileCard {
  const card = new DiffFileCard();
  card.file = file ?? mdFile();
  card.projectId = 42;
  card.branch = "main";
  return card;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiffFileCard markdown preview", () => {
  afterEach(() => {
    restoreFetch();
  });

  test("rendered is internal state, not a property", () => {
    const card = new DiffFileCard();
    const props = getElementProperties(card);
    const descriptor = props.get("rendered");
    expect(descriptor?.state).toBe(true);
  });

  test("markdownContent is internal state, not a property", () => {
    const card = new DiffFileCard();
    const props = getElementProperties(card);
    const descriptor = props.get("markdownContent");
    expect(descriptor?.state).toBe(true);
  });

  test("markdownLoading is internal state, not a property", () => {
    const card = new DiffFileCard();
    const props = getElementProperties(card);
    const descriptor = props.get("markdownLoading");
    expect(descriptor?.state).toBe(true);
  });

  test("card starts with rendered = false", () => {
    const card = new DiffFileCard();
    expect(card["rendered"]).toBe(false);
  });

  test("toggleRendered flips rendered state without emitting an event", () => {
    mockFetch(() => new Response("# Hello"));
    const card = cardWithProject();

    const events: string[] = [];
    card.addEventListener("toggle-rendered", () => events.push("toggle-rendered"));

    card["_toggleRendered"]();

    expect(card["rendered"]).toBe(true);
    expect(events).toEqual([]);
  });

  test("toggleRendered fetches and caches markdown on first enable", async () => {
    mockFetch(() => new Response("# Hello World"));
    const card = cardWithProject();

    await card["_toggleRendered"]();

    expect(card["rendered"]).toBe(true);
    expect(card["markdownContent"]).toContain("Hello World");
    // markdownContent now stores raw markdown text (rendering is done by <markdown-content>)
    expect(card["markdownContent"]).toBe("# Hello World");
  });

  test("toggleRendered back to diff does not clear cache", async () => {
    mockFetch(() => new Response("# Cached"));
    const card = cardWithProject();

    await card["_toggleRendered"](); // on
    card["_toggleRendered"](); // off

    expect(card["rendered"]).toBe(false);
    expect(card["markdownContent"]).toContain("Cached");
  });

  test("second toggle-on uses cache and does not re-fetch", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return new Response("# Once");
    });
    const card = cardWithProject();

    await card["_toggleRendered"](); // on — fetches
    card["_toggleRendered"](); // off
    await card["_toggleRendered"](); // on again — should use cache

    expect(fetchCount).toBe(1);
  });

  test("cache is invalidated when file property changes (same path, new diff)", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return new Response(`# Version ${fetchCount}`);
    });
    const card = cardWithProject();

    // Simulate initial willUpdate (normally done by Lit lifecycle)
    card["willUpdate"](new Map([["file", undefined]]));

    // First render — fetches
    await card["_toggleRendered"]();
    expect(fetchCount).toBe(1);
    expect(card["markdownContent"]).toBe("# Version 1");

    // Simulate file update (same path, new diff data) — triggers willUpdate
    const updatedFile = mdFile();
    updatedFile.additions = 5;
    card.file = updatedFile;
    card["willUpdate"](new Map([["file", card.file]]));

    // Should have re-fetched since we were in rendered mode
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCount).toBe(2);
    expect(card["markdownContent"]).toBe("# Version 2");
  });

  test("cache is cleared when file property changes to different path", async () => {
    mockFetch(() => new Response("# Original"));
    const card = cardWithProject();

    // Simulate initial willUpdate
    card["willUpdate"](new Map([["file", undefined]]));

    await card["_toggleRendered"]();
    expect(card["rendered"]).toBe(true);
    expect(card["markdownContent"]).toBe("# Original");

    // Simulate component reuse with a different file
    card.file = mdFile("docs/other.md");
    card["willUpdate"](new Map([["file", card.file]]));

    expect(card["rendered"]).toBe(false);
    expect(card["markdownContent"]).toBe(null);
  });

  test("fetch error stores error message in markdownContent", async () => {
    mockFetch(() => new Response("", { status: 500 }));
    const card = cardWithProject();

    await card["_toggleRendered"]();

    expect(card["markdownError"]).toContain("500");
    expect(card["markdownContent"]).toBe(null);
  });

  test("markdownLoading is true during fetch", async () => {
    let resolveResp!: (r: Response) => void;
    mockFetch(() => new Promise<Response>((r) => { resolveResp = r; }));
    const card = cardWithProject();

    const promise = card["_toggleRendered"]();

    expect(card["markdownLoading"]).toBe(true);

    resolveResp(new Response("# Done"));
    await promise;

    expect(card["markdownLoading"]).toBe(false);
  });

  test("no fetch when projectId is null", async () => {
    let fetched = false;
    mockFetch(() => { fetched = true; return new Response(""); });

    const card = new DiffFileCard();
    card.file = mdFile();
    // no projectId set

    await card["_toggleRendered"]();

    expect(card["rendered"]).toBe(true);
    expect(fetched).toBe(false);
    expect(card["markdownContent"]).toBe(null);
  });
});

describe("DiffFileCard file URL generation", () => {
  test("builds URL with projectId, path, and branch", () => {
    const card = cardWithProject(mdFile("docs/guide.md"));
    const url = card["_fileUrl"]();

    expect(url).toBe("/api/projects/42/file?path=docs%2Fguide.md&ref=main");
  });

  test("omits ref param when branch is null", () => {
    const card = new DiffFileCard();
    card.file = mdFile("README.md");
    card.projectId = 7;
    card.branch = null;

    const url = card["_fileUrl"]();

    expect(url).toBe("/api/projects/7/file?path=README.md");
  });

  test("returns null when projectId is null", () => {
    const card = new DiffFileCard();
    card.file = mdFile();
    card.projectId = null;

    expect(card["_fileUrl"]()).toBe(null);
  });
});
