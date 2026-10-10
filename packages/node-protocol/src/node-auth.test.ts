import { test, expect } from "bun:test";
import { authenticateParams, encodeNodePublicKey, generateNodeKeyPair, newNodeChallenge, parseNodePublicKey, signNodeChallenge, verifyNodeAnswer } from "./node-auth.js";

const ORIGIN = "https://reins.example.test";

test("an answer verifies only for the origin, node ID, challenge ID and nonce it was signed for, under the signing key", () => {
  const { publicKey, privateKey } = generateNodeKeyPair();
  const challenge = newNodeChallenge();
  expect(authenticateParams.safeParse(challenge).success).toBe(true);
  const answer = signNodeChallenge({ origin: ORIGIN, privateKey }, "node-a", challenge);
  expect(answer.nodeId).toBe("node-a");
  expect(verifyNodeAnswer({ publicKey, origin: ORIGIN, challenge, answer })).toBe(true);

  expect(verifyNodeAnswer({ publicKey, origin: "https://other.example.test", challenge, answer })).toBe(false);
  expect(verifyNodeAnswer({ publicKey, origin: ORIGIN, challenge, answer: { ...answer, nodeId: "node-b" } })).toBe(false);
  expect(verifyNodeAnswer({ publicKey, origin: ORIGIN, challenge: { ...challenge, challengeId: crypto.randomUUID() }, answer })).toBe(false);
  expect(verifyNodeAnswer({ publicKey, origin: ORIGIN, challenge: { ...challenge, nonce: newNodeChallenge().nonce }, answer })).toBe(false);
  expect(verifyNodeAnswer({ publicKey: generateNodeKeyPair().publicKey, origin: ORIGIN, challenge, answer })).toBe(false);
  // A stored key that is not an Ed25519 public key verifies nothing.
  expect(verifyNodeAnswer({ publicKey: "not-a-key", origin: ORIGIN, challenge, answer })).toBe(false);
});

test("a node public key is the canonical base64url of the raw 32 bytes, from either half of the pair", () => {
  const { publicKey, privateKey } = generateNodeKeyPair();
  expect(Buffer.from(publicKey, "base64url")).toHaveLength(32);
  expect(encodeNodePublicKey(privateKey)).toBe(publicKey);
  expect(encodeNodePublicKey(parseNodePublicKey(publicKey)!)).toBe(publicKey);

  // A non-canonical spelling of the same bytes (the last character's unused bits set) is refused.
  const last = publicKey.at(-1)!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const sameBytes = `${publicKey.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}`;
  expect(Buffer.from(sameBytes, "base64url")).toEqual(Buffer.from(publicKey, "base64url"));
  expect(parseNodePublicKey(sameBytes)).toBeNull();
  expect(parseNodePublicKey(`${publicKey}=`)).toBeNull();
  expect(parseNodePublicKey(Buffer.alloc(16).toString("base64url"))).toBeNull();
});

test("a challenge's nonce is 32 bytes of base64url; params are parsed tolerantly", () => {
  const challenge = newNodeChallenge();
  expect(Buffer.from(challenge.nonce, "base64url")).toHaveLength(32);
  expect(authenticateParams.safeParse({ ...challenge, nonce: Buffer.alloc(16).toString("base64url") }).success).toBe(false);
  expect(authenticateParams.safeParse({ ...challenge, challengeId: "not-a-uuid" }).success).toBe(false);
  expect(authenticateParams.safeParse({ ...challenge, future: true }).success).toBe(true);
});
