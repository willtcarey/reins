import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type { CredentialLocks, ServerProcess } from "../state.js";
import { getDb } from "../db.js";
import {
  deleteAllAuthCredentials,
  getPreferredAuthCredential,
  listAuthProviders,
  setApiKeyCredential,
  setOAuthCredential,
} from "../auth-credentials-store.js";

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

/** Pi credential storage backed directly by Reins' auth_credentials table, each provider's modifications
 * serialized under the process's lock (`ServerProcess.credentials`), which every store shares, whichever
 * app's code built it. */
export class DbCredentialStore implements CredentialStore {
  constructor(private readonly locks: CredentialLocks) {}

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

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.locks.run(providerId, async () => {
      assertNotAborted(options);
      const before = readCredential(providerId);
      const next = await fn(before);
      assertNotAborted(options);
      if (next === undefined) return before;

      getDb().transaction(() => writeCredential(providerId, next))();
      return next;
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.locks.run(providerId, async () => {
      assertNotAborted(options);
      getDb().transaction(() => deleteAllAuthCredentials(providerId))();
    });
  }
}

/** The server's credential store, under the process's per-provider lock. */
export function createDbCredentialStore(serverProcess: ServerProcess): CredentialStore {
  return new DbCredentialStore(serverProcess.credentials);
}
