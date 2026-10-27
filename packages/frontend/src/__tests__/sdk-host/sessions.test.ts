import { afterEach, describe, expect, test } from "bun:test";
import { SessionOperations } from "../../models/session-operations.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { ProjectsStore } from "../../models/stores/projects-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import { SdkSessions } from "../../sdk-host/sessions.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { StubClient } from "../helpers/stub-client.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The SDK's sessions over the app's stores, which have loaded no session. */
function sdkSessions() {
  const client = new StubClient();
  const sessionCache = new SessionCache();
  const conversations = new ConversationsStore();
  const sessionOperations = new SessionOperations({ conversations });
  const sessions = new SdkSessions({ sessionOperations, sessionCache, projectsStore: new ProjectsStore(sessionCache, client) });
  return { sessions, conversations };
}

/** Answers creating a session with `created` and records the requests that change something. */
function recordWrites(respond: (url: string) => Response = () => json({ id: "created" })) {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  mockFetch((url, init) => {
    if (!init?.method || init.method === "GET") return json([]);
    writes.push({ method: init.method, url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return respond(url);
  });
  return writes;
}

afterEach(restoreFetch);

describe("SdkSessions.get", () => {
  test("asks the server for the session: its project, task, parent, name and source", async () => {
    const { sessions } = sdkSessions();
    const placement = { available: true, removed: false, nodeId: "laptop", nodeName: "Laptop", path: "/work/api" };
    mockFetch(() => json({ id: "on-task", projectId: 7, taskId: 3, parentSessionId: "lead", name: "Plan", placement }));

    expect(await sessions.get("on-task")).toEqual({
      id: "on-task",
      projectId: 7,
      taskId: 3,
      parentSessionId: "lead",
      name: "Plan",
      source: { nodeId: "laptop", path: "/work/api" },
    });
  });

  test("rejects with the server's message for a session it does not have, or when it cannot answer", async () => {
    const { sessions } = sdkSessions();
    mockFetch((url) => url === "/api/sessions/unknown"
      ? json({ error: "Session not found" }, 404)
      : json({ error: "Database is locked" }, 500));

    await expect(sessions.get("unknown")).rejects.toThrow("Session not found");
    await expect(sessions.get("on-task")).rejects.toThrow("Database is locked");
  });
});

describe("SdkSessions.create", () => {
  test("creates a session of the project with what it is given", async () => {
    const { sessions } = sdkSessions();
    const writes = recordWrites();
    const source = { nodeId: "laptop", path: "/work/api" };

    expect(await sessions.create({ projectId: 7 })).toBe("created");
    expect(await sessions.create({ projectId: 7, taskId: 3, source, title: "Plan", model: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" } })).toBe("created");

    expect(writes).toEqual([
      { method: "POST", url: "/api/projects/7/sessions", body: {} },
      { method: "POST", url: "/api/projects/7/sessions", body: { taskId: 3, source, title: "Plan", model: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" } } },
    ]);
  });

  test("submits a prompt as the new session's first message, shown in its conversation at once, and resolves once it was admitted", async () => {
    const { sessions, conversations } = sdkSessions();
    const writes = recordWrites((url) => url.endsWith("/prompt") ? json({ ok: true }) : json({ id: "created" }));

    await sessions.create({ projectId: 7, prompt: "Plan the migration" });

    expect(writes).toEqual([
      { method: "POST", url: "/api/projects/7/sessions", body: {} },
      { method: "POST", url: "/api/sessions/created/prompt", body: { clientId: expect.any(String), message: [{ type: "text", text: "Plan the migration" }] } },
    ]);
    expect(conversations.get("created").messages.map((message) => [message.role, message.toMarkdown()])).toEqual([["user", "Plan the migration"]]);
  });

  test("rejects with the server's message when the session cannot be created, or its prompt is refused", async () => {
    const { sessions } = sdkSessions();
    const writes = recordWrites(() => json({ error: "Task 4 is not a task of this project" }, 400));
    await expect(sessions.create({ projectId: 7, taskId: 4, prompt: "Hello" })).rejects.toThrow("Task 4 is not a task of this project");
    expect(writes.map((write) => write.url)).toEqual(["/api/projects/7/sessions"]);

    recordWrites((url) => url.endsWith("/prompt") ? json({ error: "Model not found: anthropic/missing" }, 400) : json({ id: "created" }));
    await expect(sessions.create({ projectId: 7, prompt: "Hello" })).rejects.toThrow("Model not found: anthropic/missing");
  });
});

describe("SdkSessions.send", () => {
  test("steers the session with the message, shown in its conversation at once, and resolves once it was admitted", async () => {
    const { sessions, conversations } = sdkSessions();
    const writes = recordWrites(() => json({ ok: true }));

    await sessions.send("on-task", "Also cover the CLI");

    expect(writes).toEqual([
      { method: "POST", url: "/api/sessions/on-task/steer", body: { clientId: expect.any(String), message: [{ type: "text", text: "Also cover the CLI" }] } },
    ]);
    expect(conversations.get("on-task").messages.map((message) => [message.role, message.toMarkdown()])).toEqual([["user", "Also cover the CLI"]]);
  });

  test("rejects with the server's refusal, which the conversation shows in place of the message", async () => {
    const { sessions, conversations } = sdkSessions();
    recordWrites(() => json({ error: "Session not found" }, 404));

    await expect(sessions.send("gone", "Hello")).rejects.toThrow("Session not found");
    expect(conversations.get("gone").messages).toEqual([]);
    expect(conversations.get("gone").errorMessage).toBe("steer failed: Session not found");
  });
});

describe("SdkSessions.compact", () => {
  test("compacts the session on the server with the instructions, rejecting with its refusal", async () => {
    const { sessions } = sdkSessions();
    const writes = recordWrites((url) => url.endsWith("/running/compact")
      ? json({ error: "The session is running; compact it once it is idle" }, 409)
      : json({ ok: true }));

    await sessions.compact("on-task", "Keep the API names");
    await expect(sessions.compact("running")).rejects.toThrow("The session is running; compact it once it is idle");

    expect(writes).toEqual([
      { method: "POST", url: "/api/sessions/on-task/compact", body: { instructions: "Keep the API names" } },
      { method: "POST", url: "/api/sessions/running/compact", body: {} },
    ]);
  });
});
