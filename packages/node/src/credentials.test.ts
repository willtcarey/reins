import { expect, test } from "bun:test";
import { fauxProvider, type Credential, type Provider } from "@earendil-works/pi-ai";
import { createRemoteCredentialStore, CREDENTIAL_CACHE_TTL_MS, NO_SERVER_MESSAGE, OAUTH_MIN_VALIDITY_MS, type CredentialServer } from "./credentials.js";
import { createPiModelRuntime, registerPiProvider, unregisterPiProvider } from "./runtime/context.js";
import type { NodeCredential } from "./protocol/schema.js";

function fakeServer(initial: Record<string, NodeCredential>) {
  const stored = new Map(Object.entries(initial));
  const calls: string[] = [];
  let gate: PromiseWithResolvers<void> | undefined;
  const server: CredentialServer & { stored: typeof stored; calls: string[]; hold(): void; release(): void } = {
    stored, calls,
    async getCredential(providerId) { calls.push(`get:${providerId}`); return stored.get(providerId) ?? null; },
    async refreshCredential(providerId) {
      calls.push(`refresh:${providerId}`);
      await gate?.promise;
      return stored.get(providerId) ?? null;
    },
    async listCredentials() { calls.push("list"); return [...stored].map(([providerId, credential]) => ({ providerId, type: credential.type })); },
    hold() { gate = Promise.withResolvers(); },
    release() { gate?.resolve(); gate = undefined; },
  };
  return server;
}

test("reads cache per provider in memory until the TTL or an invalidation, and fail clearly with no connection", async () => {
  let time = 1_000;
  const server = fakeServer({ keyed: { type: "api_key", key: "sk-one", env: { REGION: "eu" } } });
  let connected: CredentialServer | undefined = server;
  const store = createRemoteCredentialStore(() => connected, () => time);

  const reads = await Promise.all([1, 2, 3].map(() => store.read("keyed")));
  expect(reads).toEqual([1, 2, 3].map(() => ({ type: "api_key", key: "sk-one", env: { REGION: "eu" } })));
  expect(server.calls).toEqual(["get:keyed"]);
  // Logged out on the server: null, never cached.
  expect(await store.read("missing")).toBeUndefined();
  expect(await store.read("missing")).toBeUndefined();
  expect(server.calls).toEqual(["get:keyed", "get:missing", "get:missing"]);

  // A server-side change is picked up after the TTL...
  server.stored.set("keyed", { type: "api_key", key: "sk-two" });
  time += CREDENTIAL_CACHE_TTL_MS - 1;
  expect(await store.read("keyed")).toMatchObject({ key: "sk-one" });
  time += 1;
  expect(await store.read("keyed")).toMatchObject({ key: "sk-two" });
  // ...or at once after an invalidation (the node invalidates on every attach and detach).
  server.stored.delete("keyed");
  store.invalidate();
  expect(await store.read("keyed")).toBeUndefined();

  expect(await store.list()).toEqual([]);
  connected = undefined;
  store.invalidate();
  await expect(store.read("keyed")).rejects.toThrow(NO_SERVER_MESSAGE);
  await expect(store.list()).rejects.toThrow(NO_SERVER_MESSAGE);
  await expect(store.modify("keyed", async () => undefined)).rejects.toThrow(NO_SERVER_MESSAGE);
});

test("an OAuth token inside Pi's refresh window is not served from the cache", async () => {
  let time = 0;
  const server = fakeServer({ login: { type: "oauth", access: "a1", expires: OAUTH_MIN_VALIDITY_MS + 60_000 } });
  const store = createRemoteCredentialStore(() => server, () => time);
  expect(await store.read("login")).toEqual({ type: "oauth", access: "a1", expires: OAUTH_MIN_VALIDITY_MS + 60_000, refresh: "" });
  await store.read("login");
  expect(server.calls).toEqual(["get:login"]);
  time = 60_000;
  await store.read("login");
  expect(server.calls).toEqual(["get:login", "get:login"]);
});

test("modify asks the server to refresh once for concurrent callers, never runs a refresh on the node, and rejects logins and logouts", async () => {
  const server = fakeServer({ login: { type: "oauth", access: "fresh", expires: Date.now() + 3_600_000 } });
  const store = createRemoteCredentialStore(() => server);
  const probed: Array<Credential | undefined> = [];
  // Pi's refresh function: leaves anything but an expiring OAuth credential unchanged.
  const refresh = async (current: Credential | undefined) => { probed.push(current); return current?.type === "oauth" ? { ...current, access: "node-refreshed" } : undefined; };

  server.hold();
  const results = Promise.all([1, 2, 3].map(() => store.modify("login", refresh)));
  await Bun.sleep(1);
  server.release();
  expect((await results).map(credential => credential?.type === "oauth" && credential.access)).toEqual(["fresh", "fresh", "fresh"]);
  expect(server.calls).toEqual(["refresh:login"]);
  expect(probed.every(current => current === undefined)).toBe(true);
  // The refreshed token is cached: a later read or modify needs no call.
  expect(await store.read("login")).toMatchObject({ access: "fresh" });
  expect(await store.modify("login", refresh)).toMatchObject({ access: "fresh" });
  expect(server.calls).toEqual(["refresh:login"]);

  const login = { type: "api_key" as const, key: "typed-on-the-node" };
  await expect(store.modify("login", async () => login)).rejects.toThrow("Credentials are managed by the Reins server: sign in on the server");
  await expect(store.delete("login")).rejects.toThrow("Credentials are managed by the Reins server: log out on the server");
  expect(server.calls).toEqual(["refresh:login"]);
});

test("Pi resolving an expired OAuth login on the node gets the server's refreshed token with one refresh call for concurrent requests", async () => {
  const faux = fauxProvider({ provider: "remote-oauth-faux", models: [{ id: "fake" }] });
  const nodeRefreshes: unknown[] = [];
  const provider: Provider = { ...faux.provider, auth: { oauth: {
    name: "Remote OAuth",
    login: async () => { throw new Error("no login on the node"); },
    refresh: async credential => { nodeRefreshes.push(credential); throw new Error("the node must not refresh"); },
    toAuth: async credential => ({ apiKey: credential.access }),
  } } };
  registerPiProvider(provider);
  const server = fakeServer({ [provider.id]: { type: "oauth", access: "expired", expires: Date.now() - 1 } });
  const refreshCredential = server.refreshCredential.bind(server);
  server.refreshCredential = async providerId => {
    server.stored.set(providerId, { type: "oauth", access: "rotated", expires: Date.now() + 3_600_000 });
    return refreshCredential(providerId);
  };
  try {
    const store = createRemoteCredentialStore(() => server);
    const models = await createPiModelRuntime({ credentials: store });
    server.calls.length = 0;
    store.invalidate();
    const auths = await Promise.all([1, 2, 3, 4].map(() => models.getAuth(provider.id)));
    expect(auths.map(auth => auth?.auth.apiKey)).toEqual(["rotated", "rotated", "rotated", "rotated"]);
    expect(server.calls.filter(call => call.startsWith("refresh"))).toEqual([`refresh:${provider.id}`]);
    expect(nodeRefreshes).toEqual([]);
    // Subsequent requests use the cached token.
    server.calls.length = 0;
    expect((await models.getAuth(provider.id))?.auth.apiKey).toBe("rotated");
    expect(server.calls).toEqual([]);

    // Logged out on the server: Pi reports no auth, as for a node with no credentials.
    server.stored.delete(provider.id);
    store.invalidate();
    expect(await models.getAuth(provider.id)).toBeUndefined();
  } finally { unregisterPiProvider(provider.id); }
});
