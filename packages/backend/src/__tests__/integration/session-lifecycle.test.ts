import { nodeRuntimesForTesting } from "@reins/node/node";
import { submit } from "../../sessions/node-execution.js";
import { describe, test, expect, spyOn } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getDb } from "../../db.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { loadMessages } from "../../messages-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createSession as createNewSession } from "../../sessions/create-session.js";
import { SessionInstance } from "../../sessions/session-instance.js";
import { storedInput } from "../../pi-session-store.js";
import { Sessions } from "../../models/sessions.js";
import { createPiModelRuntime } from "../../pi/factory.js";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { connectLoopbackNode, loopbackNodeFor, openingTarget, stopLoopbackNode } from "../helpers/loopback-node.js";
import type { ServerState } from "../../state.js";

/** Starts process-owned delivery and connects a node; only process shutdown closes the hub. */
function installWithNode(state: ServerState): () => void {
  state.nodes.start();
  connectLoopbackNode(state);
  return () => state.nodes.close();
}

function createCapturingWsClient() {
  const sent: any[] = [];
  return {
    client: {
      ws: {
        send(payload: string) {
          sent.push(JSON.parse(payload));
          return payload.length;
        },
      },
    },
    sent,
  };
}

describe("a session across the server and a node", () => {
  useTestDb();
  const repo = useTestRepo();
  test("a new session runs on its node over the server's storage, and a restarted node reopens it from the server", async () => {
    const provider = fauxProvider({ provider: "node-spike-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }, { id: "other", contextWindow: 200_000, maxTokens: 1_000 }] });
    provider.setResponses([fauxAssistantMessage("Node reply"), fauxAssistantMessage("After restart reply")]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    expect((await createPiModelRuntime()).getModel("node-spike-faux", "fake")).toBeDefined();
    const state = createServerState();
    const client = createCapturingWsClient();
    state.clients.add(client.client);
    const stop = installWithNode(state);
    const project = createProject("Node-backed", repo.dir);
    try {
      const created = createNewSession(state, project.id, {
        model: { provider: provider.provider.id, modelId: "fake" },
      });
      submit(state.nodes, created.id, { op: "prompt", content: [{ type: "text", text: "Hello node" }], clientId: "node-client" });
      // The server waits on its projections (outbox, durable lifecycle reports, its own transcript).
      createSession("caller", project.id, { agentRuntimeType: "pi" });
      expect(await new SessionInstance(state, "caller").wait(created.id, 10_000))
        .toEqual({ sessionId: created.id, status: "completed", result: "Node reply", error: null });
      expect(loadMessages(created.id).some(m => JSON.stringify(m).includes("Node reply"))).toBe(true);
      expect(client.sent.some(message => message.type === "event" && message.event.type === "agent_end" && message.sessionId === created.id)).toBe(true);
      expect(getSession(created.id)?.activity_state).toBe("finished");
      // The row changes at once; the node applies the queued session.setModel to Pi's lane.
      await new Sessions(state.nodes).setModel({
        sessionId: created.id, provider: provider.provider.id, modelId: "other",
      });
      expect(getSession(created.id)?.model_id).toBe("other");
      // Delivered commands leave the outbox.
      const modelSet = () => !getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.setModel'").get(created.id);
      for (let i = 0; i < 100 && !modelSet(); i++) await Bun.sleep(10);
      expect((await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, openingTarget(created.id))).getSessionMetadata()?.model?.modelId).toBe("other");
      await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
      await stopLoopbackNode(state); // the node process restarts; the server hub stays alive
      connectLoopbackNode(state);
      try {
        const reopened = await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, openingTarget(created.id));
        expect(JSON.stringify(await reopened.getMessages())).toContain("Node reply");
        submit(state.nodes, created.id, { op: "steer", content: [{ type: "text", text: "After restart" }], clientId: "after-restart" });
        // Admission is proven by the server's storage: the node committed the input before answering.
        for (let i = 0; i < 100 && getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ?").get(created.id); i++) await Bun.sleep(10);
        expect(storedInput(created.id, "after-restart")).not.toBeNull();
        await reopened.waitForIdle();
        expect(JSON.stringify(loadMessages(created.id))).toContain("After restart reply");
        await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
      } finally { await stopLoopbackNode(state); }
    } finally {
      stop();
      await stopLoopbackNode(state);
      unregisterPiProvider(provider.provider.id);
    }
  }, 15_000);

  test("prompts retain attachment references and hydrate image bytes for Pi on the node", async () => {
    const provider = fauxProvider({ provider: "node-image-faux", models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
    let providerContext: unknown;
    provider.setResponses([(context) => { providerContext = structuredClone(context.messages); return fauxAssistantMessage("Image received"); }]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    const state = createServerState();
    const client = createCapturingWsClient();
    state.clients.add(client.client);
    const stop = installWithNode(state);
    const warn = spyOn(console, "warn");
    try {
      const project = createProject("Node image", repo.dir);
      const created = createNewSession(state, project.id, { model: { provider: provider.provider.id, modelId: "fake" } });
      const attachment = storeSessionAttachment(created.id, { data: Buffer.from("node image bytes"), mimeType: "image/png", filename: "image.png" });
      submit(state.nodes, created.id, { op: "prompt", clientId: "node-image-client", content: [
        { type: "text", text: "Inspect image" },
        { type: "image", attachmentId: attachment.id, mimeType: attachment.mimeType, filename: attachment.filename, byteSize: attachment.byteSize, sha256: attachment.sha256 },
      ] });
      for (let i = 0; i < 100 && !nodeRuntimesForTesting(loopbackNodeFor(state)).has(created.id); i++) await Bun.sleep(10);
      const runtime = await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, openingTarget(created.id));
      await runtime.waitForIdle();
      expect(JSON.stringify(providerContext)).toContain(Buffer.from("node image bytes").toString("base64"));
      expect(JSON.stringify(loadMessages(created.id))).toContain(attachment.id);
      // The prompt's image is already a reference: its live events reach the browser (none dropped).
      for (let i = 0; i < 100 && !client.sent.some(message => message.event?.type === "agent_end"); i++) await Bun.sleep(5);
      expect(warn.mock.calls.filter(([message]) => String(message).includes("Dropped"))).toEqual([]);
      const promptEvents = client.sent.filter(message => message.type === "event" && message.sessionId === created.id
        && JSON.stringify(message.event).includes(attachment.id)).map(message => message.event.type);
      expect(promptEvents).toEqual(["message_start", "message_end", "entry_added"]);
      await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
    } finally { warn.mockRestore(); stop(); await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id); }
  }, 15_000);
});

