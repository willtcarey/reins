/**
 * Node Routes
 *
 *   GET  /api/nodes                 — every node, in name order: whether it is connected now, whether it was
 *                                     paired (the seeded local node never was), its hostname, and when it
 *                                     was paired and revoked
 *   POST /api/nodes/pairing-codes   — a single-use code ({name?}: the paired node's name) a remote node
 *                                     redeems within 10 minutes: 201 {id, code, expiresAt}; only its hash is
 *                                     kept, and `id` names it in `node_paired`
 *   POST /api/nodes/pair            — redeem a code ({code, publicKey, hostname}; publicKey: base64url of a
 *                                     raw Ed25519 key) for a new node bound to the key: 201 {nodeId, name}
 *                                     (403: unknown, used or expired code; 409: the key is already paired)
 *   POST /api/nodes/:nodeId/reload  — restart the node on its new code at a clean point ({force?}); answers
 *                                     once the reload is scheduled (409: the node refused; 503: offline)
 *   POST /api/nodes/:nodeId/revoke  — refuse the paired node from now on and close its link: the node view
 *                                     (409: never paired; revoking again is a no-op)
 *   DELETE /api/nodes/:nodeId       — remove the paired node, revoked or not: close its link and delete it,
 *                                     so its key is refused from then on: 204 (409: never paired, or it still
 *                                     holds project sources, named in the error)
 *
 * Browsers hear of changes over the WebSocket: `node_paired {pairingCodeId, node}` on a redemption,
 * `node_updated {node}` when a node connects, disconnects or is revoked, `node_removed {nodeId}`.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { listNodeDetails } from "../node-store.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { createBroadcast } from "../models/broadcast.js";
import { NodeInUseError, NodeNotFoundError, NodeNotPairedError, NodeRefusedError, nodeView, reloadNode, removeNode, revokeNode, type NodeServices } from "../models/nodes.js";
import { createPairingCode, InvalidPairingCodeError, InvalidPublicKeyError, PublicKeyInUseError, redeemPairingCode } from "../models/node-pairing.js";
import { parseBody } from "./validate.js";
import type { ServerState } from "../state.js";

const ReloadBodySchema = Type.Object({ force: Type.Optional(Type.Boolean()) });
const PairingCodeBodySchema = Type.Object({ name: Type.Optional(Type.String({ maxLength: 100 })) });
const PairBodySchema = Type.Object({
  code: Type.String({ maxLength: 100 }),
  publicKey: Type.String({ maxLength: 100 }),
  hostname: Type.String({ minLength: 1, maxLength: 255 }),
});

const services = (state: ServerState): NodeServices => ({ nodes: state.nodes, broadcast: createBroadcast(state.clients) });

export function registerNodeRoutes(router: RouterGroup) {
  router.get(API.nodes, async (ctx) => {
    return Response.json(listNodeDetails().map(node => nodeView(ctx.state.nodes, node)));
  });

  router.post(`${API.nodes}/pairing-codes`, async (ctx) => {
    const { name } = await parseBody(PairingCodeBodySchema, ctx.req);
    return Response.json(createPairingCode({ name: name?.trim() || null }), { status: 201 });
  });

  router.post(`${API.nodes}/pair`, async (ctx) => {
    const body = await parseBody(PairBodySchema, ctx.req);
    try {
      return Response.json(redeemPairingCode(services(ctx.state), body), { status: 201 });
    } catch (error) {
      if (error instanceof InvalidPublicKeyError) badRequest(error.message);
      if (error instanceof InvalidPairingCodeError) throw new HttpError(403, error.message);
      if (error instanceof PublicKeyInUseError) conflict(error.message);
      throw error;
    }
  });

  router.post(`${API.nodes}/:nodeId/reload`, async (ctx) => {
    // The body is optional (`curl -X POST` works).
    const text = await ctx.req.text();
    let body: unknown = {};
    try { if (text.trim()) body = JSON.parse(text); } catch { badRequest("Invalid JSON in request body"); }
    if (!Value.Check(ReloadBodySchema, body)) badRequest("Invalid request body: expected {force?: boolean}");
    try {
      return Response.json(await reloadNode(ctx.state.nodes, ctx.params.nodeId, body));
    } catch (error) {
      if (error instanceof NodeNotFoundError) notFound(error.message);
      if (error instanceof NodeRefusedError) conflict(error.message);
      throw error;
    }
  });

  router.post(`${API.nodes}/:nodeId/revoke`, async (ctx) => {
    try {
      return Response.json(revokeNode(services(ctx.state), ctx.params.nodeId));
    } catch (error) {
      if (error instanceof NodeNotFoundError) notFound(error.message);
      if (error instanceof NodeNotPairedError) conflict(error.message);
      throw error;
    }
  });

  router.delete(`${API.nodes}/:nodeId`, async (ctx) => {
    try {
      removeNode(services(ctx.state), ctx.params.nodeId);
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof NodeNotFoundError) notFound(error.message);
      if (error instanceof NodeNotPairedError || error instanceof NodeInUseError) conflict(error.message);
      throw error;
    }
  });
}
