import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { connectScriptedNode, SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { createNodeSession, queuePrompt } from "../helpers/node-session.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../project-fixture.js";
import { createSession, updateActivityState } from "../session-fixture.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { getDb } from "../../db.js";
import { createSource } from "../../node-store.js";
import type { WsClient } from "../../state.js";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

describe("session routes (top-level)", () => {
  let state: ReturnType<typeof createServerState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    state = createServerState();
    router = buildRouter();
    const p = createProject("Test Project", repo.dir);
    projectId = p.id;
  });

  describe("GET /api/sessions/:sessionId", () => {
    test("returns a session with projectId", async () => {
      const sessionId = "lookup-memory";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.id).toBe(sessionId);
      expect(body.projectId).toBe(projectId);
      expect(body.taskId).toBeNull();
      expect(body.messageCount).toBe(0);
      expect(body.background).toBe(false);
      expect(body).not.toHaveProperty("project_id");
      expect(body).not.toHaveProperty("task_id");
    });

    test("marks a background session so the browser can keep it out of lists and badges", async () => {
      createSession("hidden", projectId, { agentRuntimeType: "pi", background: true });

      const res = await router.handle(makeRequest("GET", "/api/sessions/hidden"), state);

      expect(res!.status).toBe(200);
      expect(await res!.json()).toMatchObject({ id: "hidden", background: true });
    });

    test("uses DB model metadata", async () => {
      const sessionId = "lookup-memory-db-first";
      createSession(sessionId, projectId, {
        agentRuntimeType: "pi",
        modelProvider: "openai",
        modelId: "gpt-5",
        thinkingLevel: "minimal",
      });

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.state.model).toEqual({ provider: "openai", id: "gpt-5" });
      expect(body.state.thinkingLevel).toBe("minimal");
    });

    test("returns metadata-only session from DB with projectId", async () => {
      const sessionId = "lookup-db";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});
      persistCanonicalMessages(sessionId, [
        { role: "user", content: textContent("test") },
      ]);

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.id).toBe(sessionId);
      expect(body.projectId).toBe(projectId);
      expect(body.messageCount).toBe(1);
      expect(body.activityState).toBeNull();
      expect(body.pinnedAt).toBeNull();
      expect(body.archivedAt).toBeNull();
      expect(body).not.toHaveProperty("pinned_at");
      expect(body).not.toHaveProperty("archived_at");
      expect(body).not.toHaveProperty("messages");
    });

    test("returns a durable operation only when it is pending without an active driver", async () => {
      const sessionId = "pending-operation";
      createSession(sessionId, projectId, { agentRuntimeType: "pi" });
      getDb().query("INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, "pi.lane.state", "main", 1, JSON.stringify({ currentOperationId: "op-1", lastOperationId: null, inbox: [] }));
      getDb().query("INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, "pi.op.meta", "op-1", 2, JSON.stringify({ operationId: "op-1", intent: { kind: "run" } }));

      const pending = await router.handle(makeRequest("GET", `/api/sessions/${sessionId}`), state);
      expect((await pending!.json()).pendingOperation).toEqual({ kind: "run" });

      // The session now runs on its node: its node's run drives the operation.
      getDb().query("UPDATE sessions SET activity_state = 'running' WHERE id = ?").run(sessionId);
      const active = await router.handle(makeRequest("GET", `/api/sessions/${sessionId}`), state);
      expect((await active!.json()).pendingOperation).toBeNull();
    });

    test("returns server-side activityState", async () => {
      const sessionId = "activity-state";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});
      updateActivityState(sessionId, "finished");

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.activityState).toBe("finished");
    });

    test("restores a normalized context snapshot through the session resource", async () => {
      const sessionId = "context-snapshot";
      const provider = getProviders().find((candidate) => getModels(candidate).length > 0)!;
      const model = getModels(provider)[0]!;
      createSession(sessionId, projectId, {
        agentRuntimeType: "pi",
        modelProvider: provider,
        modelId: model.id,
      });

      const res = await router.handle(makeRequest("GET", `/api/sessions/${sessionId}/context`), state);

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({
        usedTokens: 0,
        contextWindow: model.contextWindow,
        compactionThresholdTokens: Math.max(0, model.contextWindow - 16_384),
        utilization: 0,
        measurement: "exact",
      });
    });

    test("returns the latest durable occupancy while compaction is in progress", async () => {
      const sessionId = "context-compacting";
      const provider = getProviders().find((candidate) => getModels(candidate).length > 0)!;
      const model = getModels(provider)[0]!;
      createSession(sessionId, projectId, {
        agentRuntimeType: "pi",
        modelProvider: provider,
        modelId: model.id,
      });
      persistCanonicalMessages(sessionId, [{
        id: "assistant", role: "assistant", content: textContent("answer"), stopReason: "stop", timestamp: 1,
      }]);
      getDb().query("INSERT INTO pi_usage (session_id,id,seq,entry_id,adjustment,usage_json) VALUES (?,?,?,?,0,?)")
        .run(sessionId, "usage", 2, "assistant", JSON.stringify({
          input: 40, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }));
      const res = await router.handle(makeRequest("GET", `/api/sessions/${sessionId}/context`), state);

      expect(await res!.json()).toMatchObject({ usedTokens: 2, measurement: "estimated" });
    });

    test("returns 404 for nonexistent session", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/sessions/nonexistent`),
        state,
      );
      expect(res!.status).toBe(404);
      expect(await res!.json()).toEqual({ error: "Session not found" });
    });

  });

  describe("PATCH /api/sessions/:sessionId/metadata", () => {
    test("renames a session and clears the name back to its fallback", async () => {
      createSession("renamed", projectId, { agentRuntimeType: "pi" });

      const rename = await router.handle(
        makeRequest("PATCH", "/api/sessions/renamed/metadata", { name: "  Important investigation  " }),
        state,
      );
      expect(rename!.status).toBe(200);
      expect(await rename!.json()).toMatchObject({ name: "Important investigation" });

      const clear = await router.handle(
        makeRequest("PATCH", "/api/sessions/renamed/metadata", { name: "" }),
        state,
      );
      expect(clear!.status).toBe(200);
      expect(await clear!.json()).toMatchObject({ name: null });
    });

    test("pins, archives, and unarchives independently", async () => {
      createSession("organized", projectId, { agentRuntimeType: "pi" });

      const archive = await router.handle(
        makeRequest("PATCH", "/api/sessions/organized/metadata", { pinned: true, archived: true }),
        state,
      );
      expect(archive!.status).toBe(200);
      expect(await archive!.json()).toMatchObject({ pinnedAt: expect.any(String), archivedAt: expect.any(String) });
      expect(archive!.headers.get("content-type")).toContain("application/json");

      const unarchive = await router.handle(
        makeRequest("PATCH", "/api/sessions/organized/metadata", { archived: false }),
        state,
      );
      expect(unarchive!.status).toBe(200);
      expect(await unarchive!.json()).toMatchObject({ pinnedAt: expect.any(String), archivedAt: null });

      const unpin = await router.handle(
        makeRequest("PATCH", "/api/sessions/organized/metadata", { pinned: false }),
        state,
      );
      expect(unpin!.status).toBe(200);
      expect(await unpin!.json()).toMatchObject({ pinnedAt: null, archivedAt: null });
    });

    test("broadcasts metadata changes", async () => {
      createSession("broadcast-organized", projectId, { agentRuntimeType: "pi" });
      const sent: unknown[] = [];
      const client: WsClient = {
        ws: {
          send: (payload: string) => {
            sent.push(JSON.parse(payload));
            return payload.length;
          },
        },
      };
      state.clients.add(client);

      await router.handle(
        makeRequest("PATCH", "/api/sessions/broadcast-organized/metadata", { pinned: true }),
        state,
      );

      expect(sent).toEqual([{
        type: "session_updated",
        sessionId: "broadcast-organized",
        projectId,
      }]);
    });

    test("returns 404 for a missing session", async () => {
      const res = await router.handle(
        makeRequest("PATCH", "/api/sessions/missing/metadata", { pinned: true }),
        state,
      );
      expect(res!.status).toBe(404);
      expect(await res!.json()).toEqual({ error: "Session not found" });
    });
  });

  describe("POST /api/sessions/:sessionId/move", () => {
    const move = (sessionId: string, body: unknown) => router.handle(makeRequest("POST", `/api/sessions/${sessionId}/move`, body), state);

    test("moves an idle session to another node's source, closing it on the node it left, and answers with its placement", async () => {
      createNodeSession("movable", projectId);
      getDb().query("INSERT INTO nodes (id, name) VALUES ('other', 'Other')").run();
      const other = createSource(projectId, "other", "/elsewhere");
      const internal = useFakeNode(state);
      const target = useFakeNode(state, "other");
      await Promise.all([internal.link.ready(), target.link.ready()]);

      // Onto the node it is already on: nothing changes.
      expect(await (await move("movable", { nodeId: "internal" }))!.json()).toEqual({ available: true, nodeId: "internal", nodeName: "Internal", path: repo.dir });

      const moved = await move("movable", { nodeId: "other" });
      expect(moved!.status).toBe(200);
      expect(await moved!.json()).toEqual({ available: true, nodeId: "other", nodeName: "Other", path: "/elsewhere" });
      expect(getDb().query("SELECT source_id FROM sessions WHERE id = 'movable'").get()).toEqual({ source_id: other.id });
      await until(() => internal.closed.length > 0);
      expect(internal.closed).toEqual(["movable"]);
      expect(target.closed).toEqual([]);
      // There is no release back to the server.
      expect((await move("movable", { nodeId: null }))!.status).toBe(400);
    });

    test("rejects a busy session, an unknown node, a missing session and an invalid body", async () => {
      createNodeSession("busy", projectId);
      queuePrompt("busy", "pending");
      getDb().query("INSERT INTO nodes (id, name) VALUES ('other', 'Other')").run();
      createSource(projectId, "other", "/elsewhere");
      const busy = await move("busy", { nodeId: "other" });
      expect(busy!.status).toBe(409);
      expect(await busy!.json()).toEqual({ error: "Session has an active run or pending input; try again when it is idle" });
      createSession("resting", projectId, { agentRuntimeType: "pi" });
      expect((await move("resting", { nodeId: "elsewhere" }))!.status).toBe(409);
      expect((await move("missing", { nodeId: "internal" }))!.status).toBe(404);
      expect((await move("resting", {}))!.status).toBe(400);
    });
  });

  describe("GET /api/sessions/:sessionId/move-targets", () => {
    const targets = async (sessionId: string) => router.handle(makeRequest("GET", `/api/sessions/${sessionId}/move-targets`), state);
    const view = async (sessionId: string) => (await (await router.handle(makeRequest("GET", `/api/sessions/${sessionId}`), state))!.json());

    test("lists every node, eligible first, marking where the session is and which nodes lack the project; the session view's placement names its node", async () => {
      createNodeSession("placed", projectId);
      getDb().query("INSERT INTO nodes (id, name) VALUES ('other', 'Other'), ('unrelated', 'Alpha')").run();
      createSource(projectId, "other", "/elsewhere");

      const listedTargets = await targets("placed");
      expect(listedTargets!.status).toBe(200);
      expect(await listedTargets!.json()).toEqual([
        { nodeId: "other", name: "Other", connected: false, eligible: true },
        { nodeId: "unrelated", name: "Alpha", connected: false, eligible: false, reason: "no_source" },
        { nodeId: "internal", name: "Internal", connected: false, eligible: false, reason: "current" },
      ]);
      const placedView = await view("placed");
      // `available`: whether its node is connected.
      expect(placedView.placement).toEqual({ available: false, nodeId: "internal", nodeName: "Internal", path: repo.dir });
      expect(placedView).not.toHaveProperty("moveTargetCount");

      await useFakeNode(state).link.ready();
      expect((await (await targets("placed"))!.json()).at(-1)).toEqual({ nodeId: "internal", name: "Internal", connected: true, eligible: false, reason: "current" });
      expect(await view("placed")).toMatchObject({ placement: { available: true, nodeId: "internal", nodeName: "Internal" } });
      const [listed] = await (await router.handle(makeRequest("GET", `/api/projects/${projectId}/sessions`), state))!.json();
      expect(listed).toMatchObject({ id: "placed", placement: { nodeId: "internal", nodeName: "Internal" } });
      expect(listed).not.toHaveProperty("location");
      expect(listed).not.toHaveProperty("moveTargetCount");

      // Once moved, the node of its new source is the current one.
      await router.handle(makeRequest("POST", "/api/sessions/placed/move", { nodeId: "other" }), state);
      expect((await (await targets("placed"))!.json()).map((target: { nodeId: string; reason?: string }) => [target.nodeId, target.reason]))
        .toEqual([["internal", undefined], ["unrelated", "no_source"], ["other", "current"]]);
    });

    test("returns 404 for a missing session", async () => {
      expect((await targets("missing"))!.status).toBe(404);
    });
  });

  describe("POST /api/sessions/:sessionId/resume", () => {
    test("resumes a pending operation on the node without adding a prompt", async () => {
      const sessionId = "resume-operation";
      createSession(sessionId, projectId, { agentRuntimeType: "pi" });
      const node = useFakeNode(state);
      await node.link.ready();

      const res = await router.handle(makeRequest("POST", `/api/sessions/${sessionId}/resume`), state);

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ ok: true });
      expect(node.sent.map((command) => command.op)).toEqual(["session.resumePending"]);
    });

    test("answers 409 when the node finds nothing to resume", async () => {
      const sessionId = "resume-nothing";
      createSession(sessionId, projectId, { agentRuntimeType: "pi" });
      const link = connectScriptedNode(state, SEEDED_NODE_ID, { resumePending: async () => ({ started: false }) });
      await link.ready();

      const res = await router.handle(makeRequest("POST", `/api/sessions/${sessionId}/resume`), state);

      expect(res!.status).toBe(409);
      expect(await res!.json()).toEqual({ error: "The session has no interrupted operation to resume" });
      link.stop();
    });

    test("returns 404 for a missing session", async () => {
      const res = await router.handle(makeRequest("POST", "/api/sessions/missing/resume"), state);

      expect(res!.status).toBe(404);
      expect(await res!.json()).toEqual({ error: "Session not found" });
    });
  });

  describe("GET /api/sessions/:sessionId/messages", () => {
    test("returns persisted messages for an existing session", async () => {
      const sessionId = "messages-existing";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});
      persistCanonicalMessages(sessionId, [
        { role: "user", content: textContent("hello"), timestamp: 1000 },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          timestamp: 2000,
        },
      ]);

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages`),
        state,
      );

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({
        items: [
          {
            id: expect.any(String),
            parentId: null,
            seq: 0,
            clientId: expect.any(String),
            message: {
              role: "user",
              content: [{ type: "text", text: "hello" }],
              timestamp: 1000,
            },
          },
          {
            id: expect.any(String),
            parentId: expect.any(String),
            seq: 1,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              timestamp: 2000,
            },
          },
        ],
        pageInfo: {
          hasPreviousPage: false,
          previousCursor: null,
          hasNextPage: false,
          endCursor: expect.any(String),
        },
      });
    });

    test("returns [] for an existing session with no messages", async () => {
      const sessionId = "messages-empty";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages`),
        state,
      );

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({
        items: [],
        pageInfo: {
          hasPreviousPage: false,
          previousCursor: null,
          hasNextPage: false,
          endCursor: null,
        },
      });
    });

    test("paginates backward without splitting tool calls from their results", async () => {
      const sessionId = "messages-pages";
      createSession(sessionId, projectId, { agentRuntimeType: "pi" });
      persistCanonicalMessages(sessionId, [
        { role: "user", content: textContent("first") },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
        { role: "toolResult", toolCallId: "call-1", isError: false, content: textContent("result") },
        { role: "user", content: textContent("latest") },
      ]);

      const latest = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages?limit=2`), state,
      );
      const latestBody = await latest!.json();
      expect(latestBody.items.map((item: any) => item.message.role)).toEqual(["assistant", "toolResult", "user"]);
      expect(latestBody.items[0].parentId).toEqual(expect.any(String));
      expect(latestBody.items[1].parentId).toBe(latestBody.items[0].id);
      expect(latestBody.items[2].parentId).toBe(latestBody.items[1].id);
      expect(latestBody.pageInfo.hasPreviousPage).toBe(true);
      expect(latestBody.pageInfo.previousCursor).toEqual(expect.any(String));

      const previous = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages?limit=2&before=${encodeURIComponent(latestBody.pageInfo.previousCursor)}`), state,
      );
      const previousBody = await previous!.json();
      expect(previousBody.items.map((item: any) => item.message.role)).toEqual(["user", "assistant"]);
      expect(previousBody.items[0].parentId).toBeNull();
      expect(previousBody.items[1].parentId).toBe(previousBody.items[0].id);
      expect(latestBody.items[0].parentId).toBe(previousBody.items[1].id);
      expect(previousBody.pageInfo).toMatchObject({ hasPreviousPage: false, previousCursor: null });
      expect(new Set([...previousBody.items, ...latestBody.items].map((item: any) => item.id)).size).toBe(5);
    });

    test("paginates forward from an opaque end cursor without splitting tool results", async () => {
      const sessionId = "messages-forward-pages";
      createSession(sessionId, projectId, { agentRuntimeType: "pi" });
      persistCanonicalMessages(sessionId, [
        { role: "user", content: textContent("initial") },
        { role: "assistant", content: [{ type: "text", text: "initial reply" }] },
      ]);

      const initial = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages?limit=2`), state,
      );
      const initialBody = await initial!.json();

      persistCanonicalMessages(sessionId, [
        { role: "assistant", content: [{ type: "toolCall", id: "call-forward", name: "read", arguments: {} }] },
        { role: "toolResult", toolCallId: "call-forward", isError: false, content: textContent("result") },
        { role: "user", content: textContent("later") },
      ]);

      const firstForward = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages?limit=1&after=${encodeURIComponent(initialBody.pageInfo.endCursor)}`), state,
      );
      const firstForwardBody = await firstForward!.json();
      expect(firstForwardBody.items.map((item: any) => item.message.role)).toEqual(["assistant", "toolResult"]);
      expect(firstForwardBody.pageInfo.hasNextPage).toBe(true);
      const forwardCursor = firstForwardBody.pageInfo.endCursor;
      expect(forwardCursor).toEqual(expect.any(String));

      const secondForward = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages?limit=1&after=${encodeURIComponent(forwardCursor)}`), state,
      );
      expect(secondForward!.status).toBe(200);
      const secondForwardBody = await secondForward!.json();
      expect(secondForwardBody.items.map((item: any) => item.message.role)).toEqual(["user"]);
      expect(secondForwardBody.pageInfo).toMatchObject({ hasNextPage: false, endCursor: expect.any(String) });
    });

    test("rejects invalid pagination parameters", async () => {
      const sessionId = "messages-invalid-page";
      createSession(sessionId, projectId, { agentRuntimeType: "pi" });

      const badLimit = await router.handle(makeRequest("GET", `/api/sessions/${sessionId}/messages?limit=0`), state);
      const badCursor = await router.handle(makeRequest("GET", `/api/sessions/${sessionId}/messages?before=not-a-cursor`), state);

      expect(badLimit!.status).toBe(400);
      expect(badCursor!.status).toBe(400);
    });

    test("returns 404 for nonexistent session", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/sessions/nonexistent/messages`),
        state,
      );

      expect(res!.status).toBe(404);
      expect(await res!.json()).toEqual({ error: "Session not found" });
    });
  });
});
