import { test, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { authenticateParams, newNodeChallenge, signNodeChallenge, verifyNodeAnswer } from "./node-auth.js";

const ORIGIN = "https://reins.example.test";
const keypair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ format: "jwk" }).x!, privateKey };
};

test("an answer verifies only for the origin, node ID, challenge ID and nonce it was signed for, under the signing key", () => {
  const { publicKey, privateKey } = keypair();
  const challenge = newNodeChallenge();
  expect(authenticateParams.safeParse(challenge).success).toBe(true);
  const answer = signNodeChallenge({ nodeId: "node-a", origin: ORIGIN, privateKey }, challenge);
  expect(answer.nodeId).toBe("node-a");
  expect(verifyNodeAnswer({ publicKey, origin: ORIGIN, challenge, answer })).toBe(true);

  expect(verifyNodeAnswer({ publicKey, origin: "https://other.example.test", challenge, answer })).toBe(false);
  expect(verifyNodeAnswer({ publicKey, origin: ORIGIN, challenge, answer: { ...answer, nodeId: "node-b" } })).toBe(false);
  expect(verifyNodeAnswer({ publicKey, origin: ORIGIN, challenge: { ...challenge, challengeId: crypto.randomUUID() }, answer })).toBe(false);
  expect(verifyNodeAnswer({ publicKey, origin: ORIGIN, challenge: { ...challenge, nonce: newNodeChallenge().nonce }, answer })).toBe(false);
  expect(verifyNodeAnswer({ publicKey: keypair().publicKey, origin: ORIGIN, challenge, answer })).toBe(false);
  // A stored key that is not an Ed25519 public key verifies nothing.
  expect(verifyNodeAnswer({ publicKey: "not-a-key", origin: ORIGIN, challenge, answer })).toBe(false);
});

test("a challenge's nonce is 32 bytes of base64url; params are parsed tolerantly", () => {
  const challenge = newNodeChallenge();
  expect(Buffer.from(challenge.nonce, "base64url")).toHaveLength(32);
  expect(authenticateParams.safeParse({ ...challenge, nonce: Buffer.alloc(16).toString("base64url") }).success).toBe(false);
  expect(authenticateParams.safeParse({ ...challenge, challengeId: "not-a-uuid" }).success).toBe(false);
  expect(authenticateParams.safeParse({ ...challenge, future: true }).success).toBe(true);
});
