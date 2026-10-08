/**
 * Tests for NodesStore — the node list, pairing codes and revocation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { NodeView } from "@backend/routes/nodes.js";
import { NodesStore } from "../../../models/stores/nodes-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const localNode: NodeView = { id: "internal", name: "Internal", connected: true, paired: false, hostname: null, pairedAt: null, revokedAt: null };
const laptop: NodeView = { id: "laptop", name: "Laptop", connected: false, paired: true, hostname: "laptop.local", pairedAt: "2026-10-01T09:00:00.000Z", revokedAt: null };

describe("NodesStore", () => {
  afterEach(() => {
    restoreFetch();
  });

  test("load lists every node", async () => {
    mockFetch((url) => url === "/api/nodes" ? jsonResponse([localNode, laptop]) : jsonResponse({}, 500));
    const store = new NodesStore();

    const result = await store.load();

    expect(result).toEqual({ ok: true });
    expect(store.nodes.data).toEqual([localNode, laptop]);
    expect(store.nodes.loading).toBe(false);
  });

  test("a created pairing code is kept until dismissed", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    mockFetch((url, init) => {
      requests.push({ url, body: init?.body });
      return jsonResponse({ code: "single-use-code", expiresAt: "2026-10-08T12:10:00.000Z" }, 201);
    });
    const store = new NodesStore();

    const result = await store.createPairingCode(" Laptop ");

    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([{ url: "/api/nodes/pairing-codes", body: JSON.stringify({ name: "Laptop" }) }]);
    expect(store.pairingCode).toEqual({ code: "single-use-code", expiresAt: "2026-10-08T12:10:00.000Z" });

    store.dismissPairingCode();

    expect(store.pairingCode).toBeNull();
  });

  test("a pairing code without a name lets the server name the node", async () => {
    const bodies: unknown[] = [];
    mockFetch((_url, init) => {
      bodies.push(init?.body);
      return jsonResponse({ code: "single-use-code", expiresAt: "2026-10-08T12:10:00.000Z" }, 201);
    });
    const store = new NodesStore();

    await store.createPairingCode("  ");

    expect(bodies).toEqual([JSON.stringify({})]);
  });

  test("revoke replaces the node with the server's revoked view", async () => {
    const revoked: NodeView = { ...laptop, revokedAt: "2026-10-08T12:00:00.000Z" };
    mockFetch((url, init) => {
      if (url === "/api/nodes" && !init?.method) return jsonResponse([localNode, laptop]);
      if (url === "/api/nodes/laptop/revoke" && init?.method === "POST") return jsonResponse(revoked);
      return jsonResponse({}, 500);
    });
    const store = new NodesStore();
    await store.load();

    const result = await store.revoke("laptop");

    expect(result).toEqual({ ok: true });
    expect(store.nodes.data).toEqual([localNode, revoked]);
  });

  test("a refused revocation leaves the node as it was", async () => {
    mockFetch((url, init) => {
      if (url === "/api/nodes" && !init?.method) return jsonResponse([localNode]);
      return jsonResponse({ error: "Node was never paired: internal" }, 409);
    });
    const store = new NodesStore();
    await store.load();

    const result = await store.revoke("internal");

    expect(result).toEqual({ error: "Node was never paired: internal" });
    expect(store.nodes.data).toEqual([localNode]);
  });
});
