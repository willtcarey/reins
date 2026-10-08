import { afterEach, describe, expect, test } from "bun:test";
import { ReinsClient, ReinsHttpError } from "./reins-client.js";

/** A client whose transport records each request and answers from `respond`. */
function recordingClient(respond: (init?: RequestInit) => Response = () => Response.json({ ok: true }), options: { baseUrl?: string } = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ReinsClient({
    ...options,
    fetch: async (input, init) => {
      requests.push({ url: input, init });
      return respond(init);
    },
  });
  return { client, requests };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("Expected the request to fail"); }, (error: unknown) => error);
}

describe("ReinsClient", () => {
  test("owns endpoint construction and JSON request serialization", async () => {
    const { client, requests } = recordingClient();

    await client.sessions.setActivity("session / one", { unread: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/sessions/session%20%2F%20one/activity");
    expect(requests[0]?.init).toMatchObject({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unread: true }),
    });
  });

  test("exposes the normalized session context snapshot resource", async () => {
    const { client, requests } = recordingClient(() => Response.json({
      usedTokens: 42_000, contextWindow: 200_000, compactionThresholdTokens: 183_616, utilization: 0.21, measurement: "exact",
    }));

    expect(await client.sessions.context("session / one")).toEqual({
      usedTokens: 42_000, contextWindow: 200_000, compactionThresholdTokens: 183_616, utilization: 0.21, measurement: "exact",
    });
    expect(requests.map(request => request.url)).toEqual(["/api/sessions/session%20%2F%20one/context"]);
  });

  test("decodes resource responses without exposing transport descriptors", async () => {
    const responses = [
      Response.json([{
        id: 1,
        name: "Reins",
        path: "/workspace/reins",
        base_branch: "main",
        created_at: "2026-01-01T00:00:00Z",
        last_opened_at: "2026-01-01T00:00:00Z",
      }]),
      new Response("diff --git a/a b/a"),
    ];
    const client = new ReinsClient({ fetch: async () => responses.shift()! });

    const projects = await client.projects.list();
    const patch = await client.diff.patch(1, {
      context: 3,
      mode: "branch",
      branch: "task/client",
    });

    expect(projects[0]?.name).toBe("Reins");
    expect(patch).toBe("diff --git a/a b/a");
  });

  test("throws a typed HTTP error with the decoded server detail", async () => {
    const { client } = recordingClient(() => Response.json({ error: "Project not found" }, { status: 404 }));

    const error = await rejection(client.projects.get(42));
    expect(error).toBeInstanceOf(ReinsHttpError);
    expect(error).toMatchObject({ status: 404, message: "Project not found", body: { error: "Project not found" } });
  });

  test("a success that is not JSON where JSON is expected is a typed HTTP error", async () => {
    const html = "<!doctype html><html><body>app</body></html>";
    for (const response of [
      () => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      () => new Response("{not json", { headers: { "Content-Type": "application/json" } }),
      () => new Response(null, { status: 204 }),
    ]) {
      const { client } = recordingClient(response);
      const error = await rejection(client.nodes.reload("internal"));
      expect(error).toBeInstanceOf(ReinsHttpError);
      expect(error).toMatchObject({ message: expect.stringMatching(/^POST \/api\/nodes\/internal\/reload answered \d+ without JSON/) });
    }
  });

  test("forwards AbortSignal from resource methods", async () => {
    const controller = new AbortController();
    const { client, requests } = recordingClient(() => Response.json([]));

    await client.projects.list({ signal: controller.signal });

    expect(requests[0]?.init?.signal).toBe(controller.signal);
  });

  test("produces encoded browser resource URLs", () => {
    const client = new ReinsClient();

    expect(client.sessions.attachmentUrl("session / one", "attachment/1")).toBe(
      "/api/sessions/session%20%2F%20one/attachments/attachment%2F1",
    );
    expect(client.files.contentUrl(7, "docs/a b.pdf", { ref: "topic/client", download: true })).toBe(
      "/api/projects/7/files/content?path=docs%2Fa+b.pdf&ref=topic%2Fclient&download=1",
    );
  });

  test("a base URL prefixes every request and resource URL", async () => {
    const { client, requests } = recordingClient(() => Response.json([]), { baseUrl: "http://localhost:4100/" });

    await client.nodes.list();

    expect(requests.map(request => request.url)).toEqual(["http://localhost:4100/api/nodes"]);
    expect(client.sessions.attachmentUrl("s", "a")).toBe("http://localhost:4100/api/sessions/s/attachments/a");
  });

  test("asks a node to reload, forced or not", async () => {
    const { client, requests } = recordingClient(() => Response.json({ scheduled: true }));

    expect(await client.nodes.reload("node / one", { force: true })).toEqual({ scheduled: true });
    await client.nodes.reload("internal");

    expect(requests.map(({ url, init }) => ({ url, method: init?.method, body: init?.body }))).toEqual([
      { url: "/api/nodes/node%20%2F%20one/reload", method: "POST", body: JSON.stringify({ force: true }) },
      { url: "/api/nodes/internal/reload", method: "POST", body: JSON.stringify({}) },
    ]);
  });

  test("creates pairing codes, pairs, revokes and removes nodes", async () => {
    const { client, requests } = recordingClient(init => init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({}));

    await client.nodes.createPairingCode({ name: "Laptop" });
    await client.nodes.pair({ code: "code", publicKey: "key", hostname: "box" });
    await client.nodes.revoke("node / one");
    expect(await client.nodes.remove("node / one")).toBeUndefined();

    expect(requests.map(({ url, init }) => ({ url, method: init?.method, body: init?.body }))).toEqual([
      { url: "/api/nodes/pairing-codes", method: "POST", body: JSON.stringify({ name: "Laptop" }) },
      { url: "/api/nodes/pair", method: "POST", body: JSON.stringify({ code: "code", publicKey: "key", hostname: "box" }) },
      { url: "/api/nodes/node%20%2F%20one/revoke", method: "POST", body: undefined },
      { url: "/api/nodes/node%20%2F%20one", method: "DELETE", body: undefined },
    ]);
  });

  test("uploads project files as multipart form data, through the upload transport when one is given", async () => {
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
    const { client, requests } = recordingClient(() => Response.json({ uploaded: ["a.txt", "b.txt"] }));

    expect(await client.projects.upload(7, files)).toEqual({ uploaded: ["a.txt", "b.txt"] });
    expect(requests[0]?.url).toBe("/api/projects/7/upload");
    expect(requests[0]?.init?.method).toBe("POST");
    const body = requests[0]?.init?.body;
    expect(body instanceof FormData ? body.getAll("files").map(file => (file instanceof File ? file.name : file)) : body).toEqual(["a.txt", "b.txt"]);

    const progress: number[] = [];
    const uploads: string[] = [];
    const withProgress = new ReinsClient({
      baseUrl: "http://server",
      fetch: async () => { throw new Error("uploads use the upload transport"); },
      upload: async (input, init, onProgress) => {
        uploads.push(`${init.method} ${input}`);
        onProgress?.(50);
        return Response.json({ error: "Path escapes the checkout" }, { status: 400 });
      },
    });
    const error = await rejection(withProgress.projects.upload(7, files, { onProgress: percent => progress.push(percent) }));
    expect(error).toMatchObject({ status: 400, message: "Path escapes the checkout" });
    expect(uploads).toEqual(["POST http://server/api/projects/7/upload"]);
    expect(progress).toEqual([50]);
  });
});

test("bundles for the browser from its own source alone: backend and telemetry types are type-only", async () => {
  const result = await Bun.build({ entrypoints: [`${import.meta.dir}/reins-client.ts`], target: "browser" });
  expect(result.success).toBe(true);
  const modules = (await result.outputs[0]!.text()).match(/^\/\/ \S+\.ts$/gm);
  expect(modules).toEqual(["// src/reins-client.ts"]);
});

describe("ReinsClient over HTTP", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => server?.stop(true));

  test("a server that answers its web app for an API path is an error, not a success", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }) });
    const client = new ReinsClient({ baseUrl: server.url.origin });

    expect(await rejection(client.nodes.reload("internal"))).toMatchObject({ status: 200, message: expect.stringContaining("without JSON") });
  });
});
