/**
 * A session from submission to settlement on the server (ADR-029): submitted through `Sessions`, run by
 * its runtime on the server, waited for through the scripting API, and reopened from storage.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { loadMessages } from "../../messages-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { closeSessions, useLoopbackState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { until } from "../helpers/session-host.js";
import { createSession as createNewSession } from "../../sessions/create-session.js";
import { SessionInstance } from "../../sessions/session-instance.js";
import { registerSessionKind } from "../../sessions/session-kinds.js";
import { latestSettlement } from "../../sessions/session-runs.js";
import { storedInput } from "../../pi-session-store.js";
import { Sessions } from "../../models/sessions.js";
import { registerPiProvider, unregisterPiProvider } from "../../pi/factory.js";
import { stopLoopbackNode } from "../helpers/loopback-node.js";

function createCapturingWsClient() {
  const sent: any[] = [];
  return {
    client: { ws: { send(payload: string) { sent.push(JSON.parse(payload)); return payload.length; } } },
    sent,
  };
}

describe("a session on the server", () => {
  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();

  test("a new session runs on the server over its storage; a model change applies to its lane; a new runtime reopens it from storage", async () => {
    const provider = fauxProvider({ provider: "lifecycle-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }, { id: "other", contextWindow: 200_000, maxTokens: 1_000 }] });
    provider.setResponses([fauxAssistantMessage("First reply"), fauxAssistantMessage("After reopen reply")]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    const { state } = loopback;
    const client = createCapturingWsClient();
    state.clients.add(client.client);
    const project = createProject("Lifecycle", repo.dir);
    const sessions = new Sessions(state, () => {});
    try {
      const created = createNewSession(state, project.id, { model: { provider: provider.provider.id, modelId: "fake" } });
      await sessions.submit(created.id, { op: "prompt", content: [{ type: "text", text: "Hello" }], clientId: "first" });
      createSession("caller", project.id, { agentRuntimeType: "pi" });
      expect(await new SessionInstance(state, "caller").wait(created.id, 10_000))
        .toEqual({ sessionId: created.id, status: "completed", result: "First reply", error: null });
      expect(client.sent.some(message => message.type === "event" && message.event.type === "agent_end" && message.sessionId === created.id)).toBe(true);
      expect(getSession(created.id)?.activity_state).toBe("finished");

      await sessions.setModel({ sessionId: created.id, provider: provider.provider.id, modelId: "other" });
      expect(getSession(created.id)?.model_id).toBe("other");

      // The process exits (or the runtime goes idle): the next submission opens it again from storage.
      await closeSessions(state);
      await sessions.submit(created.id, { op: "steer", content: [{ type: "text", text: "After reopen" }], clientId: "after-reopen" });
      expect(storedInput(created.id, "after-reopen")).not.toBeNull();
      await until(() => latestSettlement(created.id)?.seq === 2, "the second run settled");
      expect(JSON.stringify(loadMessages(created.id))).toContain("After reopen reply");
      expect(getSession(created.id)).toMatchObject({ model_id: "other" });
    } finally { unregisterPiProvider(provider.provider.id); }
  }, 15_000);

  test("a background session of a utility kind runs with exactly its kind's prompt and tools, without its node, settles and returns its answer", async () => {
    const provider = fauxProvider({ provider: "utility-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
    const seen: Array<{ systemPrompt?: string; tools: string[] }> = [];
    provider.setResponses([context => {
      seen.push({ systemPrompt: context.systemPrompt, tools: (context.tools ?? []).map(tool => tool.name) });
      return fauxAssistantMessage("apples, pears");
    }]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    const unregister = registerSessionKind("test-sorter", () => ({ systemPrompt: "Sort the words you are given.", tools: [], environment: false }));
    const { state } = loopback;
    await stopLoopbackNode(state);
    const project = createProject("Utility", repo.dir);
    try {
      const created = createNewSession(state, project.id, { model: { provider: provider.provider.id, modelId: "fake" }, kind: "test-sorter", background: true });
      // A slash command is not expanded for a kind without the environment.
      await new Sessions(state, () => {}).submit(created.id, { op: "prompt", content: [{ type: "text", text: "/pears apples" }], clientId: "sort" });
      createSession("caller", project.id, { agentRuntimeType: "pi" });
      expect(await new SessionInstance(state, "caller").wait(created.id, 10_000))
        .toEqual({ sessionId: created.id, status: "completed", result: "apples, pears", error: null });
      expect(seen).toEqual([{ systemPrompt: "Sort the words you are given.", tools: [] }]);
      expect(getSession(created.id)).toMatchObject({ kind: "test-sorter", background: 1, activity_state: "finished" });
    } finally {
      unregister();
      unregisterPiProvider(provider.provider.id);
    }
  }, 15_000);

  test("prompts retain attachment references and hydrate image bytes for the provider", async () => {
    const provider = fauxProvider({ provider: "image-faux", models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
    let providerContext: unknown;
    provider.setResponses([(context) => { providerContext = structuredClone(context.messages); return fauxAssistantMessage("Image received"); }]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    const { state } = loopback;
    const client = createCapturingWsClient();
    state.clients.add(client.client);
    const warn = spyOn(console, "warn");
    try {
      const project = createProject("Image", repo.dir);
      const created = createNewSession(state, project.id, { model: { provider: provider.provider.id, modelId: "fake" } });
      const attachment = storeSessionAttachment(created.id, { data: Buffer.from("image bytes"), mimeType: "image/png", filename: "image.png" });
      await new Sessions(state, () => {}).submit(created.id, { op: "prompt", clientId: "image-client", content: [
        { type: "text", text: "Inspect image" },
        { type: "image", attachmentId: attachment.id, mimeType: attachment.mimeType, filename: attachment.filename, byteSize: attachment.byteSize, sha256: attachment.sha256 },
      ] });
      await until(() => client.sent.some(message => message.event?.type === "agent_end"), "the run ended");
      expect(JSON.stringify(providerContext)).toContain(Buffer.from("image bytes").toString("base64"));
      expect(JSON.stringify(loadMessages(created.id))).toContain(attachment.id);
      // The prompt's image is already a reference: its live events reach the browser (none dropped).
      expect(warn.mock.calls.filter(([message]) => String(message).includes("Dropped"))).toEqual([]);
      const promptEvents = client.sent.filter(message => message.type === "event" && message.sessionId === created.id
        && JSON.stringify(message.event).includes(attachment.id)).map(message => message.event.type);
      expect(promptEvents).toEqual(["message_start", "message_end", "entry_added"]);
    } finally { warn.mockRestore(); unregisterPiProvider(provider.provider.id); }
  }, 15_000);
});
