import { afterEach, describe, expect, test } from "bun:test";
import type { ClientPromptContent } from "../../models/chat-content.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { ProjectsStore } from "../../models/stores/projects-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import { SessionActions } from "../../sdk-host/sessions.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { StubClient } from "../helpers/stub-client.js";

class PromptRecordingClient extends StubClient {
  readonly prompts: Array<{ sessionId: string; message: ClientPromptContent }> = [];
  override prompt(sessionId: string, message: ClientPromptContent) { this.prompts.push({ sessionId, message }); }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Session actions over the app's stores, with a session `on-task` of task 3 of project 7, on a laptop's checkout. */
function sessionActions() {
  const client = new PromptRecordingClient();
  const sessionCache = new SessionCache();
  sessionCache.set("on-task", { projectId: 7, taskId: 3, placement: { available: true, removed: false, nodeId: "laptop", nodeName: "Laptop", path: "/work/api" } });
  const conversations = new ConversationsStore();
  const shown: string[] = [];
  const actions = new SessionActions({ client, sessionCache, projectsStore: new ProjectsStore(sessionCache, client), activeConversationsStore: conversations }, (sessionId) => shown.push(sessionId));
  return { actions, client, conversations, shown };
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

describe("SessionActions.get", () => {
  test("gives a known session's project, task and source", () => {
    const { actions } = sessionActions();

    expect(actions.get("on-task")).toEqual({ id: "on-task", projectId: 7, taskId: 3, source: { nodeId: "laptop", path: "/work/api" } });
    expect(actions.get("unknown")).toBeNull();
  });
});

describe("SessionActions.create", () => {
  test("creates a session of the project with what it is given", async () => {
    const { actions } = sessionActions();
    const writes = recordWrites();
    const source = { nodeId: "laptop", path: "/work/api" };

    expect(await actions.create({ projectId: 7 })).toBe("created");
    expect(await actions.create({ projectId: 7, taskId: 3, source, title: "Plan", model: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" } })).toBe("created");

    expect(writes).toEqual([
      { method: "POST", url: "/api/projects/7/sessions", body: {} },
      { method: "POST", url: "/api/projects/7/sessions", body: { taskId: 3, source, title: "Plan", model: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" } } },
    ]);
  });

  test("submits a prompt as the new session's first message, shown in its conversation at once", async () => {
    const { actions, client, conversations } = sessionActions();
    const writes = recordWrites();

    await actions.create({ projectId: 7, prompt: "Plan the migration" });

    expect(writes.map((write) => write.body)).toEqual([{}]);
    expect(client.prompts).toEqual([{ sessionId: "created", message: [{ type: "text", text: "Plan the migration" }] }]);
    expect(conversations.get("created").messages.map((message) => [message.role, message.toMarkdown()])).toEqual([["user", "Plan the migration"]]);
  });

  test("rejects with the server's message when the session cannot be created", async () => {
    const { actions, client } = sessionActions();
    recordWrites(() => json({ error: "Task 4 is not a task of this project" }, 400));

    await expect(actions.create({ projectId: 7, taskId: 4, prompt: "Hello" })).rejects.toThrow("Task 4 is not a task of this project");
    expect(client.prompts).toEqual([]);
  });
});

describe("SessionActions.compact", () => {
  test("compacts the session on the server with the instructions, rejecting with its refusal", async () => {
    const { actions } = sessionActions();
    const writes = recordWrites((url) => url.endsWith("/running/compact")
      ? json({ error: "The session is running; compact it once it is idle" }, 409)
      : json({ ok: true }));

    await actions.compact("on-task", { instructions: "Keep the API names" });
    await expect(actions.compact("running")).rejects.toThrow("The session is running; compact it once it is idle");

    expect(writes).toEqual([
      { method: "POST", url: "/api/sessions/on-task/compact", body: { instructions: "Keep the API names" } },
      { method: "POST", url: "/api/sessions/running/compact", body: {} },
    ]);
  });
});

test("open shows the session in the workspace", () => {
  const { actions, shown } = sessionActions();

  actions.open("on-task");

  expect(shown).toEqual(["on-task"]);
});
