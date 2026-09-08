import { describe, expect, test } from "bun:test";
import { parseFileChanges } from "../../../models/changes/file-changes.js";
import { FileDiffContextState } from "../../../models/changes/file-diff-context-state.js";

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

function fileChange(patch = PATCH) {
  return parseFileChanges(patch, "snapshot").changes[0]!;
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

describe("FileDiffContextState", () => {
  test("does not fetch merely because an offscreen change has persistent context state", () => {
    let requests = 0;
    const state = new FileDiffContextState(
      { projectId: 7, mode: "branch" },
      async () => {
        requests += 1;
        throw new Error("unexpected request");
      },
    );

    expect(state.forChange(fileChange()).outcome).toBe("idle");
    expect(requests).toBe(0);
  });

  test("fetches the resulting rename path once and reconstructs the old file", async () => {
    const requests: string[] = [];
    let resolveRequest!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const state = new FileDiffContextState(
      { projectId: 7, mode: "branch", branch: "feature/review" },
      async (input) => {
        requests.push(String(input));
        return pending;
      },
    );
    const change = fileChange();

    const first = state.loadFiles(change);
    const second = state.loadFiles(change);
    expect(state.forChange(change).outcome).toBe("loading");
    expect(requests).toEqual([
      "/api/projects/7/files/content?path=src%2Fnew.ts&ref=feature%2Freview",
    ]);

    resolveRequest(textResponse("before\nnew changed\nafter\n"));
    const loaded = await Promise.all([first, second]);

    expect(loaded[0]).toMatchObject({
      oldFile: { name: "src/old.ts", contents: "before\nold changed\nafter\n" },
      newFile: { name: "src/new.ts", contents: "before\nnew changed\nafter\n" },
    });
    const acquired = state.forChange(change);
    expect(acquired).toMatchObject({
      outcome: "available",
      oldFile: { name: "src/old.ts", contents: "before\nold changed\nafter\n" },
      newFile: { name: "src/new.ts", contents: "before\nnew changed\nafter\n" },
    });
    expect(acquired.fileDiff).toBe(change.fileDiff);
    expect(acquired.expansionHistory).toEqual([]);

    await state.loadFiles(fileChange());
    expect(requests).toHaveLength(1);
  });

  test("omits ref when the review scope has no selected branch", async () => {
    const requests: string[] = [];
    const state = new FileDiffContextState(
      { projectId: 7, mode: "uncommitted" },
      async (input) => {
        requests.push(String(input));
        return textResponse("before\nnew changed\n");
      },
    );

    await state.loadFiles(fileChange());

    expect(requests).toEqual(["/api/projects/7/files/content?path=src%2Fnew.ts"]);
    expect(state.forChange(fileChange()).outcome).toBe("available");
  });

  test("retains public expansion commands for virtual remount restoration", () => {
    const state = new FileDiffContextState({ projectId: 7, mode: "branch" });
    const change = fileChange();

    state.retainExpansion(change, { hunkIndex: 0, direction: "down", lineCount: 15 });
    state.retainExpansion(change, { hunkIndex: 1, direction: "both" });

    expect(state.forChange(change).expansionHistory).toEqual([
      { hunkIndex: 0, direction: "down", lineCount: 15 },
      { hunkIndex: 1, direction: "both" },
    ]);
  });

  test("keeps the partial diff stable for binary, too-large, stale, and retrieval failures", async () => {
    const outcomes: Array<Response | Error> = [
      textResponse("Binary file (10 B). Download to view.", { "X-Reins-Content-Kind": "binary-placeholder" }),
      textResponse("small", { "Content-Length": "1048577" }),
      textResponse("stale new\n"),
      new Error("offline"),
    ];
    const change = fileChange();

    for (const result of outcomes) {
      const state = new FileDiffContextState(
        { projectId: 7, mode: "branch" },
        async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      );
      await expect(state.loadFiles(change)).rejects.toBeDefined();
      const snapshot = state.forChange(change);

      expect(snapshot.fileDiff).toBe(change.fileDiff);
      expect(snapshot.expansionHistory).toEqual([]);
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
      const state = new FileDiffContextState(
        { projectId: 7, mode: "branch" },
        async () => response,
      );
      const change = fileChange();
      await expect(state.loadFiles(change)).rejects.toBeDefined();

      expect(state.forChange(change)).toMatchObject({ outcome: "unsupported", unsupported: expected[index] });
      expect(state.forChange(change).fileDiff).toBe(change.fileDiff);
    }
  });

});
