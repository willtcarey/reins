/**
 * Pairing a remote node: the settings page creates a single-use code, and the node redeems it with its
 * Ed25519 public key, which then authenticates its connections until it is revoked.
 *
 * The code is a secret: only its SHA-256 is stored, and no error or log line carries it.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseNodePublicKey } from "@reins/node-protocol";
import { getDb } from "../db.js";
import { consumePairingGrant, getNodeDetails, insertPairedNode, insertPairingGrant, setPairingGrantNode } from "../node-store.js";
import { nodeView, type NodeServices } from "./nodes.js";

/** How long a pairing code can be redeemed. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/** An unknown, used or expired code: one error for all three, so a caller learns nothing about which. */
export class InvalidPairingCodeError extends Error {
  constructor() {
    super("Invalid or expired pairing code");
    this.name = "InvalidPairingCodeError";
  }
}

export class InvalidPublicKeyError extends Error {
  constructor() {
    super("publicKey must be a raw 32-byte Ed25519 public key in base64url");
    this.name = "InvalidPublicKeyError";
  }
}

export class PublicKeyInUseError extends Error {
  constructor() {
    super("This public key is already paired with a node");
    this.name = "PublicKeyInUseError";
  }
}

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

/** A new pairing code (32 random bytes, base64url, never starting with `-`, which `reins node pair` would
 * read as an option), redeemable once until `expiresAt`. `name` names the node it pairs (by default, the
 * node's hostname). `id` names the code, not secret, in `node_paired`. */
export function createPairingCode({ name = null }: { name?: string | null }): { id: number; code: string; expiresAt: string } {
  let code = randomBytes(32).toString("base64url");
  while (code.startsWith("-")) code = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + PAIRING_CODE_TTL_MS).toISOString();
  const id = insertPairingGrant({ codeSha256: hashCode(code), name, createdAt: new Date(now).toISOString(), expiresAt });
  return { id, code, expiresAt };
}

/**
 * Redeems `code` for a new node bound to `publicKey`, named by the code or else `hostname`. The code is
 * consumed in the transaction that inserts the node, so of competing redemptions exactly one pairs, and
 * one that fails consumes nothing. Tells browsers which code paired which node (`node_paired`). Throws
 * `InvalidPublicKeyError` (checked first), `InvalidPairingCodeError` and `PublicKeyInUseError`.
 */
export function redeemPairingCode(services: NodeServices, { code, publicKey, hostname }: { code: string; publicKey: string; hostname: string }): { nodeId: string; name: string } {
  if (!parseNodePublicKey(publicKey)) throw new InvalidPublicKeyError();
  const at = new Date().toISOString();
  const codeSha256 = hashCode(code);
  const paired = getDb().transaction(() => {
    const grant = consumePairingGrant(codeSha256, at);
    if (!grant) throw new InvalidPairingCodeError();
    const node = { id: randomUUID(), name: grant.name ?? hostname };
    try {
      insertPairedNode({ ...node, publicKey, hostname, pairedAt: at });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: nodes.public_key")) throw new PublicKeyInUseError();
      throw error;
    }
    setPairingGrantNode(grant.id, node.id);
    return { pairingCodeId: grant.id, nodeId: node.id, name: node.name };
  })();
  services.broadcast({ type: "node_paired", pairingCodeId: paired.pairingCodeId, node: nodeView(services.nodes, getNodeDetails(paired.nodeId)!) });
  return { nodeId: paired.nodeId, name: paired.name };
}
