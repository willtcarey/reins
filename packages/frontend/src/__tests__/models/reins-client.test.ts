import { describe, expect, test } from "bun:test";
import { ReinsClient, ReinsHttpError } from "../../models/reins-client.js";

describe("ReinsClient", () => {
  test("owns endpoint construction and JSON request serialization", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ReinsClient(async (input, init) => {
      requests.push({ url: input.toString(), init });
      return Response.json({ ok: true });
    });

    await client.sessions.setActivity("session / one", { unread: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/sessions/session%20%2F%20one/activity");
    expect(requests[0]?.init).toMatchObject({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unread: true }),
    });
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
    const client = new ReinsClient(async () => responses.shift()!);

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
    const client = new ReinsClient(async () => Response.json(
      { error: "Project not found" },
      { status: 404 },
    ));

    try {
      await client.projects.get(42);
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ReinsHttpError);
      expect(error).toMatchObject({
        status: 404,
        message: "Project not found",
        body: { error: "Project not found" },
      });
    }
  });

  test("forwards AbortSignal from resource methods", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const client = new ReinsClient(async (_input, init) => {
      receivedSignal = init?.signal;
      return Response.json([]);
    });

    await client.projects.list({ signal: controller.signal });

    expect(receivedSignal).toBe(controller.signal);
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
});
