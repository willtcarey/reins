import { describe, expect, test } from "bun:test";
import { ReinsClient } from "@reins/client";
import { SessionOperations } from "../../models/session-operations.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const text = (value: string) => [{ type: "text" as const, text: value }];

/** Session operations over a server answering from `respond`; `requests` records each request as `METHOD path`. */
function operations(respond: (request: string, body: unknown) => Response | Promise<Response> = () => json({ ok: true })) {
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const client = new ReinsClient({
    fetch: async (url, init) => {
      const request = `${init?.method ?? "GET"} ${url}`;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push(request);
      bodies.push(body);
      return respond(request, body);
    },
  });
  const conversations = new ConversationsStore();
  const waits: number[] = [];
  const sessionOperations = new SessionOperations({ conversations, client, wait: async (ms) => { waits.push(ms); } });
  return { sessionOperations, conversations, requests, bodies, waits };
}

/** A response the test gives when it wants. */
function deferred() {
  const { promise, resolve } = Promise.withResolvers<Response>();
  return { response: promise, answer: (response: Response = json({ ok: true })) => resolve(response) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SessionOperations", () => {
  test("submits a prompt and a steer under their client IDs, each shown in the conversation at once", async () => {
    const { sessionOperations, conversations, requests, bodies } = operations();

    const prompt = sessionOperations.submit("s", "prompt", text("hello"))!;
    const steer = sessionOperations.submit("s", "steer", text("keep going"))!;
    expect(conversations.get("s").messages.map((message) => message.toMarkdown())).toEqual(["hello", "keep going"]);
    await Promise.all([prompt.admitted, steer.admitted]);

    expect(requests).toEqual(["POST /api/sessions/s/prompt", "POST /api/sessions/s/steer"]);
    expect(bodies).toEqual([
      { clientId: prompt.entry.clientId, message: text("hello") },
      { clientId: steer.entry.clientId, message: text("keep going") },
    ]);
  });

  test("sends a session's operations one at a time, in the order they were made; other sessions do not wait", async () => {
    const prompt = deferred();
    const { sessionOperations, requests } = operations((request) => request === "POST /api/sessions/s/prompt" ? prompt.response : json({ ok: true }));

    const admitted = sessionOperations.submit("s", "prompt", text("hello"))!.admitted;
    const modelSet = sessionOperations.setModel("s", { provider: "anthropic", modelId: "claude-sonnet-4-5" });
    const compacted = sessionOperations.compact("s");
    await sessionOperations.compact("other");
    await settle();
    expect(requests).toEqual(["POST /api/sessions/s/prompt", "POST /api/sessions/other/compact"]);

    prompt.answer();
    await Promise.all([admitted, modelSet, compacted]);
    expect(requests).toEqual([
      "POST /api/sessions/s/prompt", "POST /api/sessions/other/compact", "PUT /api/sessions/s/model", "POST /api/sessions/s/compact",
    ]);
  });

  test("submits again under the same client ID until the server answers, and later operations wait for it", async () => {
    const answers: Array<() => Response> = [
      () => { throw new TypeError("Failed to fetch"); },
      () => new Response("Server reloading", { status: 503 }),
    ];
    const { sessionOperations, requests, bodies, waits } = operations((request) => (
      request.endsWith("/prompt") ? (answers.shift() ?? (() => json({ ok: true })))() : json({ ok: true })
    ));

    const admitted = sessionOperations.submit("s", "prompt", text("hello"))!.admitted;
    const compacted = sessionOperations.compact("s");
    await Promise.all([admitted, compacted]);

    expect(requests).toEqual(["POST /api/sessions/s/prompt", "POST /api/sessions/s/prompt", "POST /api/sessions/s/prompt", "POST /api/sessions/s/compact"]);
    expect(new Set(bodies.slice(0, 3).map((body) => JSON.stringify(body))).size).toBe(1);
    expect(waits).toEqual([1000, 2000]);
  });

  test("a refused submission leaves the conversation, which shows why, and rejects with the server's message", async () => {
    const { sessionOperations, conversations } = operations(() => json({ error: "Model not found: anthropic/missing" }, 400));

    const { admitted } = sessionOperations.submit("s", "steer", text("hello"))!;

    await expect(admitted).rejects.toThrow("Model not found: anthropic/missing");
    expect(conversations.get("s").messages).toEqual([]);
    expect(conversations.get("s").errorMessage).toBe("steer failed: Model not found: anthropic/missing");
  });

  test("aborts at once, not behind the session's pending operations", async () => {
    const prompt = deferred();
    const { sessionOperations, requests } = operations((request) => request.endsWith("/prompt") ? prompt.response : json({ aborted: true }));

    const admitted = sessionOperations.submit("s", "prompt", text("hello"))!.admitted;
    await settle();
    expect(await sessionOperations.abort("s")).toEqual({ aborted: true });

    expect(requests).toEqual(["POST /api/sessions/s/prompt", "POST /api/sessions/s/abort"]);
    prompt.answer();
    await admitted;
  });
});
