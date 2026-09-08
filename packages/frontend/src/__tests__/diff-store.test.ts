import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DiffStore } from "../models/stores/diff-store.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/x-diff" } });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("DiffStore", () => {
  let store: DiffStore;

  beforeEach(() => {
    store = new DiffStore();
    mockFetch((url) => {
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      if (url.includes("/git/spread")) return jsonResponse({});
      return jsonResponse({});
    });
  });

  afterEach(() => {
    store.dispose();
    restoreFetch();
  });

  test("starts with empty changed-file and patch state", () => {
    expect(store.projectId).toBeNull();
    expect(store.fileData.data).toEqual({ files: [], branch: null, baseBranch: null });
    expect(store.patchData.data).toBeNull();
    expect(store.diffMode).toBe("branch");
    expect(store.contextLines).toBe(3);
  });

  test("resets renderer state when the project changes", () => {
    store.patchData = store.patchData.asLoaded({
      patch: "old",
      cacheKeyPrefix: "old",
      version: 1,
      branch: "old",
      baseBranch: "main",
    });

    store.setProject(7);

    expect(store.projectId).toBe(7);
    expect(store.patchData.data).toBeNull();
    expect(store.fileData.data).toEqual({ files: [], branch: null, baseBranch: null });
  });

  test("fetches raw patches with branch, mode, and context semantics", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      if (url.includes("/diff/files")) {
        return jsonResponse({ files: [], branch: "feature/review", baseBranch: "main" });
      }
      if (url.includes("/diff/patch")) return textResponse("diff --git a/a.ts b/a.ts\n");
      return jsonResponse({});
    });
    store.setProject(7);
    store.setBranch("feature/review");

    await store.fetchPatchDiff();

    expect(requests).toContain("/api/projects/7/diff/patch?context=3&mode=branch&branch=feature%2Freview");
    expect(store.patchData.data).toMatchObject({
      patch: "diff --git a/a.ts b/a.ts\n",
      version: 1,
      branch: "feature/review",
      baseBranch: "main",
    });
  });

  test("changes mode without requesting the retired parsed diff endpoint", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      if (url.includes("/diff/patch")) return textResponse("");
      return jsonResponse({});
    });
    store.setProject(1);
    store.patchData = store.patchData.asLoaded({
      patch: "old",
      cacheKeyPrefix: "old",
      version: 1,
      branch: null,
      baseBranch: "main",
    });

    await store.setDiffMode("uncommitted");

    expect(store.diffMode).toBe("uncommitted");
    expect(requests).toContain("/api/projects/1/diff/patch?context=3&mode=uncommitted");
    expect(requests.some((url) => /\/diff\?/.test(url))).toBe(false);
  });

  test("keeps the latest patch when requests finish out of order", async () => {
    const older = deferredResponse();
    let patchRequests = 0;
    mockFetch((url) => {
      if (url.includes("/diff/patch")) {
        patchRequests += 1;
        return patchRequests === 1 ? older.promise : textResponse("newer");
      }
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      return jsonResponse({});
    });
    store.setProject(1);

    const first = store.fetchPatchDiff();
    await store.fetchPatchDiff();
    older.resolve(textResponse("older"));
    await first;

    expect(store.patchData.data?.patch).toBe("newer");
    expect(store.patchData.data?.version).toBe(1);
  });

  test("refreshes loaded patch data when changed-file summaries change", async () => {
    let filesRequest = 0;
    let patchRequest = 0;
    mockFetch((url) => {
      if (url.includes("/diff/files")) {
        filesRequest += 1;
        return jsonResponse({
          files: filesRequest === 1 ? [] : [{ path: "a.ts", additions: 1, removals: 0 }],
        });
      }
      if (url.includes("/diff/patch")) return textResponse(`patch-${++patchRequest}`);
      return jsonResponse({});
    });
    store.setProject(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.fetchPatchDiff();

    await store.refresh({ onlyFetchDiffIfNeeded: true, trigger: "poll" });

    expect(store.patchData.data?.patch).toBe("patch-2");
    expect(store.lastRefreshTrigger).toBe("poll-summary-changed");
  });

  test("does not refresh loaded patch data when polled summaries are unchanged", async () => {
    let patchRequests = 0;
    mockFetch((url) => {
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      if (url.includes("/diff/patch")) {
        patchRequests += 1;
        return textResponse("patch");
      }
      return jsonResponse({});
    });
    store.setProject(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.fetchPatchDiff();

    await store.refresh({ onlyFetchDiffIfNeeded: true, trigger: "poll" });

    expect(patchRequests).toBe(1);
  });

  test("clears patch state and invalidates in-flight requests", async () => {
    const response = deferredResponse();
    mockFetch((url) => {
      if (url.includes("/diff/patch")) return response.promise;
      if (url.includes("/diff/files")) return jsonResponse({ files: [] });
      return jsonResponse({});
    });
    store.setProject(1);
    const pending = store.fetchPatchDiff();

    store.clearPatchDiff();
    response.resolve(textResponse("stale"));
    await pending;

    expect(store.patchData.data).toBeNull();
  });
});
