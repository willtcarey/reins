import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { getDb } from "../../db.js";
import {
  deleteAllAuthCredentials,
  getPreferredAuthCredential,
  listAuthProviders,
  setApiKeyCredential,
  setOAuthCredential,
} from "../../auth-credentials-store.js";

const pendingModifications = new Map<string, Promise<void>>();

function assertNotAborted(options?: AuthOperationOptions): void {
  options?.signal?.throwIfAborted();
}

function readCredential(providerId: string): Credential | undefined {
  const credential = getPreferredAuthCredential(providerId);
  if (!credential) return undefined;

  if (credential.type === "api_key") {
    return { type: "api_key", key: credential.value };
  }

  return { type: "oauth", ...credential.value };
}

function writeCredential(providerId: string, credential: Credential | undefined): void {
  deleteAllAuthCredentials(providerId);
  if (!credential) return;

  if (credential.type === "api_key") {
    setApiKeyCredential(providerId, credential.key ?? "");
    return;
  }

  setOAuthCredential(providerId, {
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
    ...Object.fromEntries(
      Object.entries(credential).filter(([name]) => !["type", "refresh", "access", "expires"].includes(name)),
    ),
  });
}

/** Pi credential storage backed directly by Reins' auth_credentials table. */
export class DbCredentialStore implements CredentialStore {
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    assertNotAborted(options);
    return readCredential(providerId);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    assertNotAborted(options);
    return listAuthProviders().flatMap((providerId) => {
      const credential = readCredential(providerId);
      return credential ? [{ providerId, type: credential.type }] : [];
    });
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const previous = pendingModifications.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    pendingModifications.set(providerId, current);
    await previous;

    try {
      assertNotAborted(options);
      const before = readCredential(providerId);
      const next = await fn(before);
      assertNotAborted(options);
      if (next === undefined) return before;

      getDb().transaction(() => writeCredential(providerId, next))();
      return next;
    } finally {
      release();
      if (pendingModifications.get(providerId) === current) pendingModifications.delete(providerId);
    }
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    const previous = pendingModifications.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    pendingModifications.set(providerId, current);
    await previous;

    try {
      assertNotAborted(options);
      getDb().transaction(() => deleteAllAuthCredentials(providerId))();
    } finally {
      release();
      if (pendingModifications.get(providerId) === current) pendingModifications.delete(providerId);
    }
  }
}

export function createDbCredentialStore(): CredentialStore {
  return new DbCredentialStore();
}
