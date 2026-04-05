/**
 * Crypto utilities for settings encryption.
 *
 * AES-256-GCM encryption using a server secret. The secret is either
 * provided via REINS_SECRET env var or auto-generated and stored in
 * <data_dir>/secret.key.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { resolveDataDir } from "./db.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// Module-level encryption secret
// ---------------------------------------------------------------------------

let _secret: Buffer | null = null;

/** Initialize or override the module-level encryption secret. */
export function initEncryptionSecret(secret: Buffer): void {
  _secret = secret;
}

/**
 * Get the module-level encryption secret.
 * Lazily resolves and caches it on first use so hot-reloaded modules do not
 * require startup-time secret injection through ServerState.
 */
export function getEncryptionSecret(): Buffer {
  if (_secret) return _secret;

  _secret = getOrCreateSecret(resolveDataDir());
  return _secret;
}

/**
 * Get or create a server secret for encryption.
 *
 * Resolution order:
 * 1. REINS_SECRET env var (hex-encoded 32 bytes)
 * 2. Auto-generated key stored at <dataDir>/secret.key
 */
export function getOrCreateSecret(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const envSecret = env.REINS_SECRET?.trim();
  if (envSecret) {
    const buf = Buffer.from(envSecret, "hex");
    if (buf.length !== KEY_LENGTH) {
      throw new Error(
        `REINS_SECRET must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes), got ${envSecret.length} characters`,
      );
    }
    return buf;
  }

  const keyPath = join(dataDir, "secret.key");
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, "utf-8").trim();
    return Buffer.from(hex, "hex");
  }

  // Auto-generate
  const key = randomBytes(KEY_LENGTH);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  writeFileSync(keyPath, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns a base64-encoded string containing: iv + authTag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const secret = getEncryptionSecret();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, secret, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Throws on tampered data or wrong key.
 */
export function decrypt(encoded: string): string {
  const secret = getEncryptionSecret();
  const packed = Buffer.from(encoded, "base64");

  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, secret, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
