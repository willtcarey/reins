import { describe, expect, test } from "bun:test";
import { parseReviewItems } from "../../../models/changes/review-items.js";
import { ExpansionState } from "../../../models/changes/expansion-state.js";

const PATCH = `diff --git a/src/old.ts b/src/new.ts
similarity index 80%
rename from src/old.ts
rename to src/new.ts
index 1111111..2222222 100644
--- a/src/old.ts
+++ b/src/new.ts
@@ -2 +2 @@
-old changed
+new changed
`;

function reviewItem(patch = PATCH) {
  return parseReviewItems(patch, "snapshot").items[0]!;
}

function textResponse(contents: string, headers: Record<string, string> = {}): Response {
  return new Response(contents, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(contents).byteLength),
      ...headers,
    },
  });
}

describe("ExpansionState", () => {
  test("does not fetch merely because an offscreen item has persistent expansion state", () => {
    let requests = 0;
    const state = new ExpansionState(
      { projectId: 7, mode: "branch" },
      async () => {
        requests += 1;
        throw new Error("unexpected request");
      },
    );

    expect(state.forItem(reviewItem()).outcome).toBe("idle");
    expect(requests).toBe(0);
  });

  test("fetches the resulting rename path once and reconstructs the old file", async () => {
    const requests: string[] = [];
    let resolveRequest!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const state = new ExpansionState(
      { projectId: 7, mode: "branch", branch: "feature/review" },
      async (input) => {
        requests.push(String(input));
        return pending;
      },
    );
    const item = reviewItem();

    const first = state.acquire(item);
    const second = state.acquire(item);
    expect(state.forItem(item).outcome).toBe("loading");
    expect(requests).toEqual([
      "/api/projects/7/files/content?path=src%2Fnew.ts&ref=feature%2Freview",
    ]);

    resolveRequest(textResponse("before\nnew changed\nafter\n"));
    await Promise.all([first, second]);

    const acquired = state.forItem(item);
    expect(acquired).toMatchObject({
      outcome: "available",
      oldFile: { name: "src/old.ts", contents: "before\nold changed\nafter\n" },
      newFile: { name: "src/new.ts", contents: "before\nnew changed\nafter\n" },
      fileDiff: {
        name: "src/new.ts",
        prevName: "src/old.ts",
        type: "rename-changed",
        isPartial: false,
      },
    });
    expect(acquired.fileDiff).not.toBe(item.fileDiff);
    expect(acquired.nativeExpandedHunks.size).toBe(0);

    await state.acquire(reviewItem());
    expect(requests).toHaveLength(1);
  });

  test("omits ref when the review scope has no selected branch", async () => {
    const requests: string[] = [];
    const state = new ExpansionState(
      { projectId: 7, mode: "uncommitted" },
      async (input) => {
        requests.push(String(input));
        return textResponse("before\nnew changed\n");
      },
    );

    await state.acquire(reviewItem());

    expect(requests).toEqual(["/api/projects/7/files/content?path=src%2Fnew.ts"]);
    expect(state.forItem(reviewItem()).outcome).toBe("available");
  });

  test("retains only expansion state reported by Pierre for virtual remount restoration", () => {
    const state = new ExpansionState({ projectId: 7, mode: "branch" });
    const item = reviewItem();
    const pierreState = new Map([[0, { fromStart: 15, fromEnd: 5 }]]);

    state.retainNativeExpansion(item, pierreState);

    expect(state.forItem(item).nativeExpandedHunks).toEqual(pierreState);
    pierreState.get(0)!.fromStart = 999;
    expect(state.forItem(item).nativeExpandedHunks.get(0)).toEqual({ fromStart: 15, fromEnd: 5 });
  });

  test("keeps the partial diff stable for binary, too-large, stale, and retrieval failures", async () => {
    const outcomes: Array<Response | Error> = [
      textResponse("Binary file (10 B). Download to view.", { "X-Reins-Content-Kind": "binary-placeholder" }),
      textResponse("small", { "Content-Length": "1048577" }),
      textResponse("stale new\n"),
      new Error("offline"),
    ];
    const item = reviewItem();

    for (const result of outcomes) {
      const state = new ExpansionState(
        { projectId: 7, mode: "branch" },
        async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      );
      await state.acquire(item);
      const snapshot = state.forItem(item);

      expect(snapshot.fileDiff).toBe(item.fileDiff);
      expect(snapshot.nativeExpandedHunks.size).toBe(0);
      expect(["unsupported", "error"]).toContain(snapshot.outcome);
    }
  });

  test("detects binary MIME, NUL bytes, and actual bodies over the size limit", async () => {
    const responses = [
      new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } }),
      new Response(new Uint8Array([97, 0, 98]), { headers: { "Content-Type": "text/plain" } }),
      new Response("é".repeat(524_289), { headers: { "Content-Type": "text/plain" } }),
    ];
    const expected = [
      { reason: "binary" },
      { reason: "binary" },
      { reason: "too_large", limitBytes: 1_048_576 },
    ];

    for (const [index, response] of responses.entries()) {
      const state = new ExpansionState(
        { projectId: 7, mode: "branch" },
        async () => response,
      );
      const item = reviewItem();
      await state.acquire(item);

      expect(state.forItem(item)).toMatchObject({ outcome: "unsupported", unsupported: expected[index] });
      expect(state.forItem(item).fileDiff).toBe(item.fileDiff);
    }
  });

  test("derives complete new and deleted files from their patches without fetching", async () => {
    const newItem = reviewItem(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
`);
    const deletedItem = reviewItem(`diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-goodbye
`);
    let requests = 0;
    const state = new ExpansionState(
      { projectId: 7, mode: "branch" },
      async () => {
        requests += 1;
        throw new Error("unexpected request");
      },
    );

    await state.acquire(newItem);
    await state.acquire(deletedItem);

    expect(requests).toBe(0);
    expect(state.forItem(newItem)).toMatchObject({
      outcome: "available",
      oldFile: { name: "new.txt", contents: "" },
      newFile: { name: "new.txt", contents: "hello\n" },
      fileDiff: { name: "new.txt", type: "new", isPartial: false },
    });
    expect(state.forItem(deletedItem)).toMatchObject({
      outcome: "available",
      oldFile: { name: "gone.txt", contents: "goodbye\n" },
      newFile: { name: "gone.txt", contents: "" },
      fileDiff: { name: "gone.txt", type: "deleted", isPartial: false },
    });
  });
});
