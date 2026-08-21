import { describe, expect, test } from "bun:test";
import { parseReviewItems } from "../../../models/changes/review-items.js";
import {
  ReviewExpansionState,
  type DiffContentsResponse,
} from "../../../models/changes/review-expansion-state.js";

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

function response(body: DiffContentsResponse, status = 200): Response {
  return Response.json(body, { status });
}

describe("ReviewExpansionState", () => {
  test("does not fetch merely because an offscreen item has persistent expansion state", () => {
    let requests = 0;
    const state = new ReviewExpansionState(
      { projectId: 7, mode: "branch" },
      async () => {
        requests += 1;
        throw new Error("unexpected request");
      },
    );

    expect(state.forItem(reviewItem()).outcome).toBe("idle");
    expect(requests).toBe(0);
  });

  test("acquires complete sides once when mounted context becomes relevant", async () => {
    const requests: string[] = [];
    let resolveRequest!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const state = new ReviewExpansionState(
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
      "/api/projects/7/diff/contents?mode=branch&branch=feature%2Freview&oldPath=src%2Fold.ts&path=src%2Fnew.ts",
    ]);

    resolveRequest(response({
      status: "available",
      oldFile: {
        name: "src/old.ts",
        contents: "before\nold changed\nafter\n",
        contentId: "sha256:old",
        blobId: "old-blob",
      },
      newFile: {
        name: "src/new.ts",
        contents: "before\nnew changed\nafter\n",
        contentId: "sha256:new",
      },
    }));
    await Promise.all([first, second]);

    const acquired = state.forItem(item);
    expect(acquired).toMatchObject({
      outcome: "available",
      fileDiff: {
        name: "src/new.ts",
        prevName: "src/old.ts",
        type: "rename-changed",
        isPartial: false,
      },
    });
    expect(acquired.fileDiff).not.toBe(item.fileDiff);
    expect(acquired.fileDiff.hunks[0]?.additionStart).toBe(item.fileDiff.hunks[0]?.additionStart);
    expect(acquired.fileDiff.hunks[0]?.deletionStart).toBe(item.fileDiff.hunks[0]?.deletionStart);
    expect(acquired.nativeExpandedHunks.size).toBe(0);

    await state.acquire(reviewItem());
    expect(requests).toHaveLength(1);
  });

  test("retains only expansion state reported by Pierre for virtual remount restoration", () => {
    const state = new ReviewExpansionState({ projectId: 7, mode: "branch" });
    const item = reviewItem();
    const pierreState = new Map([[0, { fromStart: 15, fromEnd: 5 }]]);

    state.retainNativeExpansion(item, pierreState);

    expect(state.forItem(item).nativeExpandedHunks).toEqual(pierreState);
    pierreState.get(0)!.fromStart = 999;
    expect(state.forItem(item).nativeExpandedHunks.get(0)).toEqual({ fromStart: 15, fromEnd: 5 });
  });

  test("reuses content sides by stable identity across refreshed items", async () => {
    let requestCount = 0;
    const state = new ReviewExpansionState(
      { projectId: 7, mode: "uncommitted" },
      async () => {
        requestCount += 1;
        return response({
          status: "available",
          oldFile: { name: "src/old.ts", contents: "before\nold changed\n", contentId: "sha256:old", blobId: "blob-old" },
          newFile: { name: "src/new.ts", contents: "before\nnew changed\n", contentId: "sha256:new" },
        });
      },
    );
    const firstItem = reviewItem();
    const refreshedItem = reviewItem(PATCH.replace("2222222", "3333333"));

    await state.acquire(firstItem);
    await state.acquire(refreshedItem);

    expect(requestCount).toBe(2);
    expect(state.forItem(refreshedItem).oldFile).toBe(state.forItem(firstItem).oldFile);
    expect(state.forItem(refreshedItem).newFile).toBe(state.forItem(firstItem).newFile);
    expect(state.forItem(refreshedItem).fileDiff.cacheKey).toContain("blob:blob-old");
    expect(state.forItem(refreshedItem).fileDiff.cacheKey).toContain("content:sha256:new");
  });

  test("keeps the partial diff stable for unsupported, too-large, and retrieval failures", async () => {
    const outcomes: Array<DiffContentsResponse | Error> = [
      { status: "unsupported", reason: "binary" },
      { status: "too_large", limitBytes: 1_048_576 },
      {
        status: "available",
        oldFile: { name: "src/old.ts", contents: "stale old\n", contentId: "stale-old" },
        newFile: { name: "src/new.ts", contents: "stale new\n", contentId: "stale-new" },
      },
      new Error("offline"),
    ];
    const item = reviewItem();

    for (const result of outcomes) {
      const state = new ReviewExpansionState(
        { projectId: 7, mode: "branch" },
        async () => {
          if (result instanceof Error) throw result;
          return response(result);
        },
      );
      await state.acquire(item);
      const snapshot = state.forItem(item);

      expect(snapshot.fileDiff).toBe(item.fileDiff);
      expect(snapshot.nativeExpandedHunks.size).toBe(0);
      expect(["unsupported", "error"]).toContain(snapshot.outcome);
    }
  });

  test("supplies a synthetic empty side while preserving new and deleted metadata", async () => {
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
    const state = new ReviewExpansionState(
      { projectId: 7, mode: "branch" },
      async (input) => String(input).includes("new.txt")
        ? response({ status: "available", newFile: { name: "new.txt", contents: "hello\n", contentId: "new-id" } })
        : response({ status: "available", oldFile: { name: "gone.txt", contents: "goodbye\n", contentId: "old-id", blobId: "old-blob" } }),
    );

    await state.acquire(newItem);
    await state.acquire(deletedItem);

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
