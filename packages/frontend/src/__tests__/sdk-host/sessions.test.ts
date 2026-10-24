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

/** Session actions over the app's stores, with a scratch session `scratch` and a session `on-task` of task 3, both of project 7. */
function sessionActions() {
  const client = new PromptRecordingClient();
  const sessionCache = new SessionCache();
  sessionCache.set("scratch", { projectId: 7, taskId: null });
  sessionCache.set("on-task", { projectId: 7, taskId: 3 });
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

describe("SessionActions.createBeside", () => {
  test("creates a session on the task of a task session, and a new assistant conversation beside a scratch session", async () => {
    const { actions } = sessionActions();
    const writes = recordWrites();

    expect(await actions.createBeside("on-task")).toBe("created");
    expect(await actions.createBeside("scratch")).toBe("created");

    expect(writes.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST /api/tasks/3/sessions", "POST /api/projects/7/sessions"]);
  });

  test("submits a prompt as the new session's first message, shown in its conversation at once", async () => {
    const { actions, client, conversations } = sessionActions();
    recordWrites();

    await actions.createBeside("scratch", { prompt: "Plan the migration" });

    expect(client.prompts).toEqual([{ sessionId: "created", message: [{ type: "text", text: "Plan the migration" }] }]);
    expect(conversations.get("created").messages.map((message) => [message.role, message.toMarkdown()])).toEqual([["user", "Plan the migration"]]);
  });

  test("rejects with the server's message when the session cannot be created", async () => {
    const { actions, client } = sessionActions();
    recordWrites(() => json({ error: "Task not found" }, 404));

    await expect(actions.createBeside("on-task", { prompt: "Hello" })).rejects.toThrow("Task not found");
    expect(client.prompts).toEqual([]);
  });
});

describe("SessionActions.compact", () => {
  test("compacts the session on the server with the instructions, rejecting with its refusal", async () => {
    const { actions } = sessionActions();
    const writes = recordWrites((url) => url.endsWith("/running/compact")
      ? json({ error: "The session is running; compact it once it is idle" }, 409)
      : json({ ok: true }));

    await actions.compact("scratch", { instructions: "Keep the API names" });
    await expect(actions.compact("running")).rejects.toThrow("The session is running; compact it once it is idle");

    expect(writes).toEqual([
      { method: "POST", url: "/api/sessions/scratch/compact", body: { instructions: "Keep the API names" } },
      { method: "POST", url: "/api/sessions/running/compact", body: {} },
    ]);
  });
});

test("open shows the session in the workspace", () => {
  const { actions, shown } = sessionActions();

  actions.open("scratch");

  expect(shown).toEqual(["scratch"]);
});
