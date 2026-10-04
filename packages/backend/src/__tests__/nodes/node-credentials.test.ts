import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { nodeRuntimesForTesting, startNode } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { APPLICATION_ERROR } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../project-fixture.js";
import { defaultSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { openingTarget } from "../helpers/loopback-node.js";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { createDbCredentialStore } from "../../pi/credential-store.js";
import { deleteAllAuthCredentials, setApiKeyCredential, setOAuthCredential } from "../../auth-credentials-store.js";
import { createServerState } from "../helpers/server-state.js";

const REFRESH_SECRET = "refresh-secret-never-on-the-wire";
const ROTATED_SECRET = "rotated-refresh-secret-never-on-the-wire";

/** A node connected to the server's hub over its own loopback link, recording every frame. */
function linkedNode(state: ReturnType<typeof createServerState>, frames: string[]) {
  const node = startNode();
  const connect = () => {
    const [serverEnd, nodeEnd] = createLoopbackPair();
    state.nodes.accept(serverEnd, {});
    const connection = connectNode(node, nodeEnd, "internal");
    const serve = serverEnd.onmessage!;
    serverEnd.onmessage = data => { frames.push(String(data)); serve(data); };
    nodeEnd.onmessage = data => { frames.push(String(data)); connection.receive(data); };
    nodeEnd.onclose = connection.close;
    return { connection, close: () => serverEnd.close() };
  };
  return { node, connect };
}

function setup() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  return { db, state: createServerState(), teardown: () => { setDb(new Database(":memory:")); db.close(); } };
}

/** A Pi OAuth provider whose refresh the test counts; requests record the API key they were sent. */
function oauthProvider(id: string, seen: Array<string | undefined>) {
  const faux = fauxProvider({ provider: id, models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  const refreshed: OAuthCredential[] = [];
  const reply = (text: string): FauxResponseFactory => (_context, options) => { seen.push(options?.apiKey); return fauxAssistantMessage(text); };
  faux.setResponses([reply("one"), reply("two"), reply("three")]);
  const provider: Provider = { ...faux.provider, auth: { oauth: {
    name: "Test OAuth",
    login: async () => { throw new Error("not in tests"); },
    refresh: async credential => {
      refreshed.push(credential);
      await Bun.sleep(5);
      return { type: "oauth", access: `rotated-access-${refreshed.length}`, refresh: ROTATED_SECRET, expires: Date.now() + 3_600_000, enterpriseUrl: "example.test" };
    },
    toAuth: async credential => ({ apiKey: credential.access }),
  } } };
  registerPiProvider(provider);
  return { provider, refreshed };
}

test("credentials.get and credentials.list serve API keys and OAuth access tokens without refresh tokens or other fields", async () => {
  const { state, teardown } = setup();
  const frames: string[] = [];
  const { node, connect } = linkedNode(state, frames);
  const { connection, close } = connect();
  try {
    setApiKeyCredential("keyed", "sk-test-key");
    setOAuthCredential("oauthed", { access: "access-token", refresh: REFRESH_SECRET, expires: Date.now() + 3_600_000,
      enterpriseUrl: "ghe.example.test", availableModelIds: ["m1"], accountSecret: "not-for-nodes" });

    expect(await connection.getCredential("keyed")).toEqual({ type: "api_key", key: "sk-test-key" });
    expect(await connection.getCredential("oauthed")).toEqual({ type: "oauth", access: "access-token", expires: expect.any(Number),
      enterpriseUrl: "ghe.example.test", availableModelIds: ["m1"] });
    expect(await connection.getCredential("logged-out")).toBeNull();
    expect(await connection.listCredentials()).toEqual(expect.arrayContaining([{ providerId: "keyed", type: "api_key" }, { providerId: "oauthed", type: "oauth" }]));
    expect(frames.some(frame => frame.includes("credentials.list"))).toBe(true);
    expect(frames.join("\n")).not.toContain(REFRESH_SECRET);
    expect(frames.join("\n")).not.toContain("not-for-nodes");
    expect(frames.filter(frame => frame.includes('"result"') && frame.includes('"credentials"')).join()).not.toContain("sk-test-key");
  } finally { close(); await node.shutdown(); teardown(); }
});

test("the server refreshes an expired login once for concurrent requests, persists the rotation, and answers an already-refreshed login without refreshing", async () => {
  const { state, teardown } = setup();
  const frames: string[] = [];
  const { node, connect } = linkedNode(state, frames);
  const { connection, close } = connect();
  const { provider, refreshed } = oauthProvider("node-cred-refresh", []);
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    setOAuthCredential(provider.id, { access: "expired-access", refresh: REFRESH_SECRET, expires: Date.now() - 1 });
    // Several nodes (or requests) asking at once: one refresh, all get the rotated token.
    const results = await Promise.all([1, 2, 3, 4].map(() => connection.refreshCredential(provider.id)));
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ access: "expired-access", refresh: REFRESH_SECRET });
    expect(results.map(result => result?.type === "oauth" && result.access)).toEqual(Array.from({ length: 4 }, () => "rotated-access-1"));
    expect(await createDbCredentialStore().read(provider.id)).toMatchObject({ access: "rotated-access-1", refresh: ROTATED_SECRET });

    // Already refreshed (valid beyond Pi's window): returned as is.
    expect(await connection.refreshCredential(provider.id)).toMatchObject({ access: "rotated-access-1" });
    expect(refreshed).toHaveLength(1);
    // An API key or a logged-out provider has nothing to refresh.
    setApiKeyCredential("keyed", "sk-key");
    expect(await connection.refreshCredential("keyed")).toEqual({ type: "api_key", key: "sk-key" });
    expect(await connection.refreshCredential("logged-out")).toBeNull();

    // A failed refresh is an application error with NodeError data and no token material.
    setOAuthCredential("node-cred-broken", { access: "broken-access", refresh: REFRESH_SECRET, expires: Date.now() - 1 });
    registerPiProvider({ ...provider, id: "node-cred-broken", auth: { oauth: { ...provider.auth.oauth!, refresh: async () => { throw new Error("invalid_grant"); } } } });
    const failure = await connection.refreshCredential("node-cred-broken").catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ code: APPLICATION_ERROR, data: { code: "unavailable", retryable: true } });
    expect(JSON.stringify(failure) + String(failure)).not.toContain(REFRESH_SECRET);
    expect(JSON.stringify(failure) + String(failure)).not.toContain("broken-access");
    expect(error.mock.calls.flat().join(" ")).not.toContain(REFRESH_SECRET);

    const wire = frames.join("\n");
    expect(wire).not.toContain(REFRESH_SECRET);
    expect(wire).not.toContain(ROTATED_SECRET);
  } finally {
    error.mockRestore(); close(); await node.shutdown(); unregisterPiProvider(provider.id); unregisterPiProvider("node-cred-broken"); teardown();
  }
});

test("a session runs on credentials served over the link: one refresh for an expired login, cached after, re-read on reconnect, and Pi's own error when logged out", async () => {
  const { state, teardown } = setup();
  const frames: string[] = [];
  const { node, connect } = linkedNode(state, frames);
  let link = connect();
  const seen: Array<string | undefined> = [];
  const { provider, refreshed } = oauthProvider("node-cred-session", seen);
  const keyed = fauxProvider({ provider: "node-cred-keyed", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  const keyedSeen: Array<string | undefined> = [];
  const keyedReply: FauxResponseFactory = (_context, options) => { keyedSeen.push(options?.apiKey); return fauxAssistantMessage("keyed"); };
  keyed.setResponses([keyedReply, keyedReply]);
  // Requires a stored API key: no ambient fallback.
  const keyedProvider: Provider = { ...keyed.provider, auth: { apiKey: { name: "Test key",
    resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined } } };
  registerPiProvider(keyedProvider);
  try {
    const project = createProject("Credentials", "/tmp/credentials");
    const source = defaultSource(project.id)!;
    const start = (sessionId: string, providerId: string) => {
      createSession(sessionId, project.id, { agentRuntimeType: "pi", sourceId: source.id, modelProvider: providerId, modelId: "fake" });
      return openingTarget(sessionId);
    };
    const prompt = async (sessionId: string, target: ReturnType<typeof start>, clientId: string) => {
      expect(await node.prompt({ ...target, sessionId, clientId, content: [{ type: "text", text: "go" }], sourceSessionId: null })).toEqual({ inputId: clientId });
      const runtime = await nodeRuntimesForTesting(node).open(sessionId, target);
      await runtime.waitForIdle();
      return (await runtime.getMessages()).at(-1);
    };
    const calls = (method: string) => frames.filter(frame => frame.includes(`"method":"${method}"`)).length;

    setOAuthCredential(provider.id, { access: "expired-access", refresh: REFRESH_SECRET, expires: Date.now() - 1 });
    const oauthTarget = start("oauth", provider.id);
    expect(await prompt("oauth", oauthTarget, "a")).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(seen).toEqual(["rotated-access-1"]);
    expect(refreshed).toHaveLength(1);
    expect(calls("credentials.refresh")).toBe(1);
    // The next request uses the node's cached token: no credential call at all.
    const [gets, refreshes] = [calls("credentials.get"), calls("credentials.refresh")];
    await prompt("oauth", oauthTarget, "b");
    expect(seen).toEqual(["rotated-access-1", "rotated-access-1"]);
    expect([calls("credentials.get"), calls("credentials.refresh")]).toEqual([gets, refreshes]);

    // API keys: a server-side change reaches the node when its connection changes.
    setApiKeyCredential(keyed.provider.id, "sk-first");
    const keyedTarget = start("keyed", keyed.provider.id);
    await prompt("keyed", keyedTarget, "c");
    setApiKeyCredential(keyed.provider.id, "sk-second");
    link.close();
    link = connect();
    await prompt("keyed", keyedTarget, "d");
    expect(keyedSeen).toEqual(["sk-first", "sk-second"]);

    // Logged out on the server: the node gets no credential and Pi reports it as it would locally.
    deleteAllAuthCredentials(provider.id);
    link.close();
    link = connect();
    const failed = await prompt("oauth", oauthTarget, "e");
    expect(failed).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(JSON.stringify(failed)).toContain("Provider is not configured: node-cred-session");

    const wire = frames.join("\n");
    expect(wire).not.toContain(REFRESH_SECRET);
    expect(wire).not.toContain(ROTATED_SECRET);
    for (const sessionId of ["oauth", "keyed"]) await nodeRuntimesForTesting(node).close(sessionId);
  } finally {
    link.close(); await node.shutdown(); unregisterPiProvider(provider.id); unregisterPiProvider(keyed.provider.id); teardown();
  }
}, 15_000);
