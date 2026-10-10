/**
 * Tests for NodesStore — the node list and its live updates, pairing and its progress, and removal.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { NodeView } from "@backend/models/node.js";
import { NodesStore, PAIRED_DISPLAY_MS } from "../../../models/stores/nodes-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { StubClient } from "../../helpers/stub-client.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const localNode: NodeView = { id: "internal", name: "Internal", connected: true, paired: false, hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null };
const laptop: NodeView = { id: "laptop", name: "Laptop", connected: false, paired: true, hostname: "laptop.local", pairedAt: "2026-10-01T09:00:00.000Z", revokedAt: null, sources: [], build: null };
const desktop: NodeView = { id: "desktop", name: "Desktop", connected: false, paired: true, hostname: "desktop.local", pairedAt: "2026-10-08T12:05:00.000Z", revokedAt: null, sources: [], build: null };
const CREATED = { id: 7, code: "single-use-code", expiresAt: "2026-10-08T12:10:00.000Z" };

/** A scheduler the test fires by hand, recording each delay. */
function manualSchedule() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const timer = { fn, ms, cancelled: false };
    pending.push(timer);
    return () => { timer.cancelled = true; };
  };
  const live = () => pending.filter((entry) => !entry.cancelled);
  const fire = (ms: number) => { for (const timer of live().filter((entry) => entry.ms === ms)) { timer.cancelled = true; timer.fn(); } };
  return { schedule, live, fire };
}

/** A store with `nodes` loaded, its events from `client` and its timers from `timers`. */
async function loadedStore(nodes: NodeView[], client = new StubClient(), timers = manualSchedule()) {
  mockFetch((url, init) => {
    if (url === "/api/nodes" && !init?.method) return jsonResponse(nodes);
    if (url === "/api/nodes/pairing-codes") return jsonResponse(CREATED, 201);
    return jsonResponse({}, 500);
  });
  const store = new NodesStore(client, timers.schedule);
  await store.load();
  return { store, client, timers };
}

describe("NodesStore", () => {
  afterEach(() => {
    restoreFetch();
    setSystemTime();
  });

  test("load lists every node", async () => {
    mockFetch((url) => url === "/api/nodes" ? jsonResponse([localNode, laptop]) : jsonResponse({}, 500));
    const store = new NodesStore();

    const result = await store.load();

    expect(result).toEqual({ ok: true });
    expect(store.nodes.data).toEqual([localNode, laptop]);
    expect(store.nodes.loading).toBe(false);
  });

  test("a created pairing code waits for its machine until dismissed", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    mockFetch((url, init) => {
      requests.push({ url, body: init?.body });
      return jsonResponse(CREATED, 201);
    });
    const store = new NodesStore();

    const result = await store.createPairingCode(" Laptop ");

    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([{ url: "/api/nodes/pairing-codes", body: JSON.stringify({ name: "Laptop" }) }]);
    expect(store.pairing).toEqual({ ...CREATED, name: "Laptop", status: "waiting" });

    store.dismissPairingCode();

    expect(store.pairing).toBeNull();
  });

  test("a pairing code without a name lets the server name the node", async () => {
    const bodies: unknown[] = [];
    mockFetch((_url, init) => {
      bodies.push(init?.body);
      return jsonResponse(CREATED, 201);
    });
    const store = new NodesStore();

    await store.createPairingCode("  ");

    expect(bodies).toEqual([JSON.stringify({})]);
  });

  test("a redeemed code waits, without a timeout, for its node's first connection, then shows it connected and ends shortly after", async () => {
    const { store, client, timers } = await loadedStore([localNode, laptop]);
    await store.createPairingCode("Desktop");

    client.fireMessage({ type: "node_updated", node: desktop, pairingCodeId: 7 });

    expect(store.pairing).toEqual({ ...CREATED, name: "Desktop", status: "paired", node: desktop });
    expect(store.nodes.data).toEqual([desktop, localNode, laptop]);
    expect(timers.live()).toEqual([]);

    // Another node connecting is not this pairing's node.
    client.fireMessage({ type: "node_updated", node: { ...laptop, connected: true } });
    expect(store.pairing?.status).toBe("paired");

    client.fireMessage({ type: "node_updated", node: { ...desktop, connected: true } });

    expect(store.pairing).toEqual({ ...CREATED, name: "Desktop", status: "connected", node: { ...desktop, connected: true } });

    timers.fire(PAIRED_DISPLAY_MS);

    expect(store.pairing).toBeNull();
    expect(timers.live()).toEqual([]);
  });

  test("a node already connected when its code is redeemed is shown connected at once", async () => {
    const { store, client, timers } = await loadedStore([localNode]);
    await store.createPairingCode("");

    client.fireMessage({ type: "node_updated", node: { ...desktop, connected: true }, pairingCodeId: 7 });

    expect(store.pairing).toEqual({ ...CREATED, name: "", status: "connected", node: { ...desktop, connected: true } });
    expect(timers.live().map((timer) => timer.ms)).toEqual([PAIRED_DISPLAY_MS]);
  });

  test("another code's redemption lists its node but leaves this code waiting", async () => {
    const { store, client } = await loadedStore([localNode]);
    await store.createPairingCode("");

    client.fireMessage({ type: "node_updated", node: desktop, pairingCodeId: 6 });

    expect(store.pairing?.status).toBe("waiting");
    expect(store.nodes.data).toEqual([desktop, localNode]);
  });

  test("a pairing ends when its node is removed, waiting or connected", async () => {
    for (const node of [desktop, { ...desktop, connected: true }]) {
      const { store, client, timers } = await loadedStore([localNode]);
      await store.createPairingCode("Desktop");
      client.fireMessage({ type: "node_updated", node, pairingCodeId: 7 });

      client.fireMessage({ type: "node_removed", nodeId: "laptop" });
      expect(store.pairing?.status).toBe(node.connected ? "connected" : "paired");
      client.fireMessage({ type: "node_removed", nodeId: desktop.id });

      expect({ pairing: store.pairing, nodes: store.nodes.data, timers: timers.live() }).toEqual({ pairing: null, nodes: [localNode], timers: [] });
    }
  });

  test("a code still unredeemed when it expires is marked expired", async () => {
    setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const { store, timers } = await loadedStore([localNode]);
    await store.createPairingCode("");

    expect(timers.live().map((timer) => timer.ms)).toEqual([10 * 60_000]);
    timers.fire(10 * 60_000);

    expect(store.pairing).toEqual({ ...CREATED, name: "", status: "expired" });
  });

  test("node updates and removals change the listed nodes", async () => {
    const { store, client } = await loadedStore([localNode, laptop]);

    client.fireMessage({ type: "node_updated", node: { ...laptop, connected: true } });
    expect(store.nodes.data).toEqual([localNode, { ...laptop, connected: true }]);

    client.fireMessage({ type: "node_removed", nodeId: "laptop" });
    expect(store.nodes.data).toEqual([localNode]);
  });

  test("remove deletes the node and drops it from the list", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    mockFetch((url, init) => {
      requests.push({ url, method: init?.method });
      if (url === "/api/nodes" && !init?.method) return jsonResponse([localNode, laptop]);
      return new Response(null, { status: 204 });
    });
    const store = new NodesStore();
    await store.load();

    const result = await store.remove("laptop");

    expect(result).toEqual({ ok: true });
    expect(requests.at(-1)).toEqual({ url: "/api/nodes/laptop", method: "DELETE" });
    expect(store.nodes.data).toEqual([localNode]);
  });

  test("a refused removal keeps the node and reports the server's reason", async () => {
    mockFetch((url, init) => {
      if (url === "/api/nodes" && !init?.method) return jsonResponse([localNode, laptop]);
      return jsonResponse({ error: "Laptop still holds sources of these projects: Website" }, 409);
    });
    const store = new NodesStore();
    await store.load();

    const result = await store.remove("laptop");

    expect(result).toEqual({ error: "Laptop still holds sources of these projects: Website" });
    expect(store.nodes.data).toEqual([localNode, laptop]);
  });

  test("attaching a declared path loads the projects to choose from, then attaches it to the chosen one and refreshes the node's sources", async () => {
    const declaring: NodeView = { ...laptop, sources: [{ path: "/srv/docs", project: null, undeclared: false }] };
    const attached: NodeView = { ...laptop, sources: [{ path: "/srv/docs", project: { id: 4, name: "Docs", sourceId: 9 }, undeclared: false }] };
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    let nodes = [declaring];
    mockFetch((url, init) => {
      requests.push({ url, method: init?.method, body: init?.body });
      if (url === "/api/nodes") return jsonResponse(nodes);
      if (url === "/api/projects") return jsonResponse([{ id: 3, name: "Website" }, { id: 4, name: "Docs" }]);
      nodes = [attached];
      return jsonResponse({ id: 9, nodeId: "laptop", nodeName: "Laptop", connected: false, path: "/srv/docs" }, 201);
    });
    const store = new NodesStore();
    await store.load();

    await store.beginAttach("laptop", "/srv/docs");
    expect(store.attaching).toMatchObject({ nodeId: "laptop", nodeName: "Laptop", path: "/srv/docs", projectId: 3, submitting: false, error: null });
    expect(store.attaching?.projects.data).toEqual([{ id: 3, name: "Website" }, { id: 4, name: "Docs" }]);
    store.chooseAttachProject(4);

    expect(await store.attach()).toEqual({ ok: true });

    expect(requests.find((request) => request.method === "POST")).toEqual({ url: "/api/projects/4/sources", method: "POST", body: JSON.stringify({ nodeId: "laptop", path: "/srv/docs" }) });
    expect(store.attaching).toBeNull();
    expect(store.nodes.data).toEqual([attached]);
  });

  test("a refused attach keeps the choice open with the server's reason", async () => {
    const declaring: NodeView = { ...laptop, sources: [{ path: "/srv/docs", project: null, undeclared: false }] };
    mockFetch((url) => {
      if (url === "/api/nodes") return jsonResponse([declaring]);
      if (url === "/api/projects") return jsonResponse([{ id: 3, name: "Website" }]);
      return jsonResponse({ error: "Not a source of this node: /srv/docs" }, 400);
    });
    const store = new NodesStore();
    await store.load();
    await store.beginAttach("laptop", "/srv/docs");

    expect(await store.attach()).toEqual({ error: "Not a source of this node: /srv/docs" });

    expect(store.attaching).toMatchObject({ path: "/srv/docs", projectId: 3, submitting: false, error: "Not a source of this node: /srv/docs" });
    expect(store.nodes.data).toEqual([declaring]);
  });
});
