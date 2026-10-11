/**
 * Node Routes
 *
 *   GET  /api/nodes                 — every node, in name order: whether it is connected now, whether it was
 *                                     paired (the seeded local node never was), its hostname, and when it
 *                                     was paired and revoked
 *   POST /api/nodes/pairing-codes   — a single-use code ({name?}: the paired node's name) a remote node
 *                                     redeems within 10 minutes: 201 {id, code, expiresAt}; only its hash is
 *                                     kept, and `id` names it in the `node_updated` its redemption sends
 *   POST /api/nodes/pair            — redeem a code ({code, publicKey, hostname}; publicKey: base64url of a
 *                                     raw Ed25519 key) for a new node bound to the key: 201 {nodeId, name}
 *                                     (403: unknown, used or expired code; 409: the key is already paired)
 *   PATCH /api/nodes/:nodeId        — rename any node, the local one included ({name}: 1 to 100 characters
 *                                     once trimmed, 400 otherwise): the node view
 *   POST /api/nodes/:nodeId/reload  — restart the node on its new code at a clean point ({force?}); answers
 *                                     once the reload is scheduled (409: the node refused; 503: offline)
 *   POST /api/nodes/:nodeId/revoke  — refuse the paired node from now on and close its link: the node view
 *                                     (409: never paired; revoking again is a no-op)
 *   DELETE /api/nodes/:nodeId       — remove the paired node, revoked or not: close its link and delete it,
 *                                     so its key is refused from then on: 204 (409: never paired, or it still
 *                                     holds project sources, named in the error)
 *
 * Outside `/api`, what a remote node's machine reaches (`API.remoteNodes`, never the web app):
 *
 *   GET /nodes/link                 — the node link: a WebSocket a paired node dials, authenticated before
 *                                     its hello (`nodes/node-link.ts`; 426 when not an upgrade)
 *   GET /nodes/install              — the install script for the current build, filled in for the server the
 *                                     request reached; a script that fails when there is no build
 *   GET /nodes/manifest             — {buildId, sha256, bunVersion, size} of the current build
 *   GET /nodes/builds/:buildId/reins.js — the current build's bundle (404 for any other build)
 *
 * The last three are `node-bundle/delivery.ts`; see docs/dev/node-bundle.md.
 *
 * Browsers hear of changes over the WebSocket (`Nodes.publish`): `node_updated {node, pairingCodeId?}` when a
 * node is paired (naming the code), connects, disconnects, is renamed or is revoked, `node_removed {nodeId}` once it is
 * removed.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { NODE_LINK_PATH } from "@reins/node-protocol";
import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { NodeNotFoundError } from "../models/nodes.js";
import { InvalidNodeNameError, NodeInUseError, NodeNotPairedError, NodeRefusedError } from "../models/node.js";
import { InvalidPairingCodeError, InvalidPublicKeyError, PublicKeyInUseError } from "../models/node-pairing.js";
import { parseBody } from "./validate.js";

const ReloadBodySchema = Type.Object({ force: Type.Optional(Type.Boolean()) });
const RenameBodySchema = Type.Object({ name: Type.String({ maxLength: 1000 }) });
const PairingCodeBodySchema = Type.Object({ name: Type.Optional(Type.String({ maxLength: 100 })) });
const PairBodySchema = Type.Object({
  code: Type.String({ maxLength: 100 }),
  publicKey: Type.String({ maxLength: 100 }),
  hostname: Type.String({ minLength: 1, maxLength: 255 }),
});

/** The node and pairing models' errors as HTTP errors; anything else is rethrown. */
function translateNodeError(error: unknown): never {
  if (error instanceof NodeNotFoundError) notFound(error.message);
  if (error instanceof InvalidPublicKeyError || error instanceof InvalidNodeNameError) badRequest(error.message);
  if (error instanceof InvalidPairingCodeError) throw new HttpError(403, error.message);
  if (error instanceof NodeNotPairedError || error instanceof NodeInUseError || error instanceof NodeRefusedError || error instanceof PublicKeyInUseError) {
    conflict(error.message);
  }
  throw error;
}

export function registerNodeRoutes(router: RouterGroup) {
  // What a remote node's machine reaches.
  router.websocket(NODE_LINK_PATH, ({ req, server, state }) => state.nodeLinks.upgrade(req, server));
  router.get(`${API.remoteNodes}/install`, ({ req, state }) => state.nodeBundle.installScript(req));
  router.get(`${API.remoteNodes}/manifest`, ({ state }) => state.nodeBundle.manifest());
  router.get(`${API.remoteNodes}/builds/:buildId/reins.js`, ({ params, state }) => state.nodeBundle.bundle(params.buildId!));

  router.get(API.nodes, async (ctx) => {
    return Response.json(ctx.models.nodes.list());
  });

  router.post(`${API.nodes}/pairing-codes`, async (ctx) => {
    const { name } = await parseBody(PairingCodeBodySchema, ctx.req);
    return Response.json(ctx.models.nodes.pairing().createCode({ name: name?.trim() || null }), { status: 201 });
  });

  router.post(`${API.nodes}/pair`, async (ctx) => {
    const body = await parseBody(PairBodySchema, ctx.req);
    try {
      return Response.json(ctx.models.nodes.pairing().redeem(body), { status: 201 });
    } catch (error) {
      return translateNodeError(error);
    }
  });

  router.patch(`${API.nodes}/:nodeId`, async (ctx) => {
    const { name } = await parseBody(RenameBodySchema, ctx.req);
    try {
      return Response.json(ctx.models.nodes.get(ctx.params.nodeId).rename(name));
    } catch (error) {
      return translateNodeError(error);
    }
  });

  router.post(`${API.nodes}/:nodeId/reload`, async (ctx) => {
    // The body is optional (`curl -X POST` works).
    const text = await ctx.req.text();
    let body: unknown = {};
    try { if (text.trim()) body = JSON.parse(text); } catch { badRequest("Invalid JSON in request body"); }
    if (!Value.Check(ReloadBodySchema, body)) badRequest("Invalid request body: expected {force?: boolean}");
    try {
      return Response.json(await ctx.models.nodes.get(ctx.params.nodeId).reload(body));
    } catch (error) {
      return translateNodeError(error);
    }
  });

  router.post(`${API.nodes}/:nodeId/revoke`, async (ctx) => {
    try {
      return Response.json(ctx.models.nodes.get(ctx.params.nodeId).revoke());
    } catch (error) {
      return translateNodeError(error);
    }
  });

  router.delete(`${API.nodes}/:nodeId`, async (ctx) => {
    try {
      ctx.models.nodes.get(ctx.params.nodeId).remove();
      return new Response(null, { status: 204 });
    } catch (error) {
      return translateNodeError(error);
    }
  });
}
