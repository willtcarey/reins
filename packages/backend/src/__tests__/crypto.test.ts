import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { getOrCreateSecret, encrypt, decrypt } from "../crypto.js";

describe("crypto", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reins-crypto-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getOrCreateSecret", () => {
    test("uses REINS_SECRET env var when set", () => {
      const hex = randomBytes(32).toString("hex");
      const secret = getOrCreateSecret(tempDir, { REINS_SECRET: hex });
      expect(secret.toString("hex")).toBe(hex);
      // Should NOT create a file
      expect(existsSync(join(tempDir, "secret.key"))).toBe(false);
    });

    test("rejects REINS_SECRET with wrong length", () => {
      expect(() => getOrCreateSecret(tempDir, { REINS_SECRET: "abcd" })).toThrow(
        /must be 64 hex characters/,
      );
    });

    test("auto-generates and persists secret.key", () => {
      const secret1 = getOrCreateSecret(tempDir, {});
      expect(secret1.length).toBe(32);
      expect(existsSync(join(tempDir, "secret.key"))).toBe(true);

      // Second call returns the same key
      const secret2 = getOrCreateSecret(tempDir, {});
      expect(secret2.toString("hex")).toBe(secret1.toString("hex"));
    });

    test("creates data dir if it does not exist", () => {
      const nestedDir = join(tempDir, "sub", "dir");
      const secret = getOrCreateSecret(nestedDir, {});
      expect(secret.length).toBe(32);
      expect(existsSync(join(nestedDir, "secret.key"))).toBe(true);
    });
  });

  describe("encrypt / decrypt", () => {
    const secret = randomBytes(32);

    test("round-trips plaintext", () => {
      const plaintext = "sk-ant-abc123-very-secret-key";
      const encrypted = encrypt(plaintext, secret);
      const decrypted = decrypt(encrypted, secret);
      expect(decrypted).toBe(plaintext);
    });

    test("round-trips empty string", () => {
      const encrypted = encrypt("", secret);
      const decrypted = decrypt(encrypted, secret);
      expect(decrypted).toBe("");
    });

    test("round-trips unicode", () => {
      const plaintext = "秘密のキー 🔑";
      const encrypted = encrypt(plaintext, secret);
      expect(decrypt(encrypted, secret)).toBe(plaintext);
    });

    test("different secrets produce different output", () => {
      const secret2 = randomBytes(32);
      const plaintext = "same-plaintext";
      const e1 = encrypt(plaintext, secret);
      const e2 = encrypt(plaintext, secret2);
      expect(e1).not.toBe(e2);
    });

    test("same plaintext encrypts differently each time (random IV)", () => {
      const plaintext = "deterministic?";
      const e1 = encrypt(plaintext, secret);
      const e2 = encrypt(plaintext, secret);
      expect(e1).not.toBe(e2);
      // Both still decrypt correctly
      expect(decrypt(e1, secret)).toBe(plaintext);
      expect(decrypt(e2, secret)).toBe(plaintext);
    });

    test("tampered ciphertext throws", () => {
      const encrypted = encrypt("secret-data", secret);
      const buf = Buffer.from(encrypted, "base64");
      // Flip a byte in the ciphertext portion
      buf[buf.length - 1] ^= 0xff;
      const tampered = buf.toString("base64");
      expect(() => decrypt(tampered, secret)).toThrow();
    });

    test("wrong secret throws", () => {
      const encrypted = encrypt("secret-data", secret);
      const wrongSecret = randomBytes(32);
      expect(() => decrypt(encrypted, wrongSecret)).toThrow();
    });

    test("too-short data throws", () => {
      const short = Buffer.from("too-short").toString("base64");
      expect(() => decrypt(short, secret)).toThrow(/too short/);
    });
  });
});
